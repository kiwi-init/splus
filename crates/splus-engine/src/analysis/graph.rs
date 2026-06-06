//! Cross-file reference graph + blast radius (the moat).
//!
//! v1 resolution is a NAME + IMPORT-PATH heuristic over the JS/TS family: a file
//! G is a caller of symbol S defined in file F iff G imports a name S from a
//! relative specifier that resolves to F. This is honest, low-but-known
//! confidence — never presented as compiler-grade. SCIP/LSP is the precise tier.

use crate::analysis::symbols::{self, ImportRef};
use crate::collectors::{is_generated, Lang};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

pub const MAX_INDEX_FILES: usize = 4000;
pub const MAX_FILE_BYTES: u64 = 800_000;

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "dist", "build", "target", "vendor", ".next",
    "coverage", ".turbo", "out", ".venv", "__pycache__",
];

const EXTS: &[&str] = &[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

pub struct RepoGraph {
    pub files: HashSet<String>,
    pub imports_by_file: HashMap<String, Vec<ImportRef>>,
    pub indexed: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct CallerInfo {
    pub direct: Vec<String>,
    pub transitive: usize,
    pub crosses_api: bool,
}

impl RepoGraph {
    pub fn build(root: &Path) -> RepoGraph {
        let mut g = RepoGraph {
            files: HashSet::new(),
            imports_by_file: HashMap::new(),
            indexed: 0,
            truncated: false,
        };
        walk(root, root, &mut g);
        g.indexed = g.files.len();
        g
    }

    /// Resolve a relative import specifier to an indexed file path.
    fn resolve(&self, source: &str, from_file: &str) -> Option<String> {
        if !source.starts_with('.') {
            return None; // external package — not in our graph
        }
        let from_dir = from_file.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
        let mut segs: Vec<String> = if from_dir.is_empty() {
            Vec::new()
        } else {
            from_dir.split('/').map(String::from).collect()
        };
        for part in source.split('/') {
            match part {
                "." | "" => {}
                ".." => {
                    segs.pop();
                }
                p => segs.push(p.to_string()),
            }
        }
        let base = segs.join("/");

        // TS ESM commonly imports the *compiled* `.js` path for a `.ts` source
        // (`import … from "./embed.js"`). Try the source-extension forms of any
        // js-family specifier too, then the literal path.
        let stems: Vec<&str> = match base.rsplit_once('.') {
            Some((stem, "js" | "jsx" | "mjs" | "cjs")) => vec![stem, base.as_str()],
            _ => vec![base.as_str()],
        };
        for stem in stems {
            if self.files.contains(stem) {
                return Some(stem.to_string());
            }
            for ext in EXTS {
                let cand = format!("{stem}{ext}");
                if self.files.contains(&cand) {
                    return Some(cand);
                }
            }
            for ext in EXTS {
                let cand = format!("{stem}/index{ext}");
                if self.files.contains(&cand) {
                    return Some(cand);
                }
            }
        }
        None
    }

    /// Files that import `symbol` from `def_file` (direct), plus a count of
    /// files importing those (transitive, 2nd degree), and API-boundary touch.
    pub fn callers_of(&self, symbol: &str, def_file: &str) -> CallerInfo {
        let mut direct: Vec<String> = Vec::new();
        for (g, imps) in &self.imports_by_file {
            if g == def_file {
                continue;
            }
            for imp in imps {
                if imp.names.iter().any(|n| n == symbol) {
                    if let Some(res) = self.resolve(&imp.source, g) {
                        if res == def_file {
                            direct.push(g.clone());
                            break;
                        }
                    }
                }
            }
        }
        direct.sort();
        direct.dedup();

        let direct_set: HashSet<String> = direct.iter().cloned().collect();
        let mut transitive: HashSet<String> = HashSet::new();
        for (h, imps) in &self.imports_by_file {
            if h == def_file || direct_set.contains(h) {
                continue;
            }
            for imp in imps {
                if let Some(res) = self.resolve(&imp.source, h) {
                    if direct_set.contains(&res) {
                        transitive.insert(h.clone());
                        break;
                    }
                }
            }
        }

        let crosses_api =
            is_api_path(def_file) || direct.iter().any(|f| is_api_path(f));

        CallerInfo { direct, transitive: transitive.len(), crosses_api }
    }
}

fn walk(dir: &Path, root: &Path, g: &mut RepoGraph) {
    if g.truncated {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if g.truncated {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if is_dir {
            if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            walk(&path, root, g);
        } else {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if is_generated(&rel) || !Lang::from_path(&rel).is_jsish() {
                continue;
            }
            if g.files.len() >= MAX_INDEX_FILES {
                g.truncated = true;
                return;
            }
            if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(false) {
                continue;
            }
            if let Ok(src) = fs::read_to_string(&path) {
                let lang = Lang::from_path(&rel);
                let (_syms, imps) = symbols::extract(lang, &src);
                g.files.insert(rel.clone());
                g.imports_by_file.insert(rel, imps);
            }
        }
    }
}

fn is_api_path(path: &str) -> bool {
    const BOUNDARY: &[&str] = &[
        "routes", "route", "api", "handlers", "controllers", "endpoints",
        "pages", "graphql", "resolvers",
    ];
    path.split('/').any(|seg| BOUNDARY.contains(&seg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn graph_from(files: &[(&str, &str)]) -> RepoGraph {
        // Build a RepoGraph directly from in-memory sources (no fs walk).
        let mut g = RepoGraph {
            files: HashSet::new(),
            imports_by_file: HashMap::new(),
            indexed: 0,
            truncated: false,
        };
        for (path, src) in files {
            let (_s, imps) = symbols::extract(Lang::from_path(path), src);
            g.files.insert(path.to_string());
            g.imports_by_file.insert(path.to_string(), imps);
        }
        g.indexed = g.files.len();
        g
    }

    #[test]
    fn finds_direct_and_transitive_callers() {
        let g = graph_from(&[
            ("src/utils/auth.ts", "export function validateToken(t){ return !!t; }"),
            ("src/middleware/authn.ts", "import { validateToken } from '../utils/auth';\nexport function mw(){ return validateToken('x'); }"),
            ("src/api/login.ts", "import { validateToken } from '../utils/auth';\nexport function login(){ return validateToken('y'); }"),
            ("src/app.ts", "import { mw } from './middleware/authn';\nmw();"),
        ]);
        let info = g.callers_of("validateToken", "src/utils/auth.ts");
        let set: BTreeSet<_> = info.direct.iter().cloned().collect();
        assert!(set.contains("src/middleware/authn.ts"));
        assert!(set.contains("src/api/login.ts"));
        assert_eq!(info.direct.len(), 2);
        assert!(info.crosses_api); // src/api/login.ts is an API boundary
        // app.ts imports authn (a direct caller) → transitive.
        assert!(info.transitive >= 1);
    }

    #[test]
    fn resolves_ts_esm_dot_js_imports() {
        // ESM/NodeNext TS imports the compiled `.js` path for a `.ts` source.
        let g = graph_from(&[
            ("packages/x/src/embed.ts", "export function hashEmbedder(){ return 1; }"),
            ("packages/x/src/index.ts", "import { hashEmbedder } from './embed.js';\nhashEmbedder();"),
        ]);
        let info = g.callers_of("hashEmbedder", "packages/x/src/embed.ts");
        assert_eq!(info.direct, vec!["packages/x/src/index.ts".to_string()]);
    }

    #[test]
    fn does_not_match_same_name_from_other_file() {
        let g = graph_from(&[
            ("src/a.ts", "export function run(){ return 1; }"),
            ("src/b.ts", "export function run(){ return 2; }"),
            ("src/c.ts", "import { run } from './b';\nrun();"),
        ]);
        // run defined in a.ts has NO callers (c imports from b, not a).
        let info = g.callers_of("run", "src/a.ts");
        assert_eq!(info.direct.len(), 0);
        let info_b = g.callers_of("run", "src/b.ts");
        assert_eq!(info_b.direct.len(), 1);
    }
}
