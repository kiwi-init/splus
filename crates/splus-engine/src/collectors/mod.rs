//! Collector framework. Each collector is a deterministic producer of Findings,
//! scoped to the clean-as-you-code changed set provided by the ReviewContext.

pub mod blast_radius;
pub mod complexity;
pub mod external;
pub mod heuristics;
pub mod secrets;

use crate::diff::{self, DiffMode};
use crate::model::ChangedFile;
use std::fs;
use std::path::PathBuf;

/// Upper bound on a single file re-read for content analysis. Mirrors the graph
/// indexer's cap so the complexity/blast-radius collectors don't load huge blobs.
const MAX_HEAD_BYTES: u64 = 800_000;

/// Everything a collector needs: the changed files + helpers to read content.
pub struct ReviewContext {
    pub root: PathBuf,
    pub mode: DiffMode,
    pub files: Vec<ChangedFile>,
    /// Loaded SCIP index for the precise blast-radius tier, if available.
    pub scip: Option<crate::analysis::scip::ScipGraph>,
}

impl ReviewContext {
    /// Head (current) content of a file, read from the working tree.
    /// Skips files larger than `MAX_HEAD_BYTES` so a giant checked-in blob with a
    /// code extension can't be loaded wholesale into memory / tree-sitter.
    pub fn head_content(&self, path: &str) -> Option<String> {
        let full = self.root.join(path);
        if fs::metadata(&full).map(|m| m.len() > MAX_HEAD_BYTES).unwrap_or(false) {
            return None;
        }
        fs::read_to_string(full).ok()
    }

    /// Base ("before") content of a file at the diff's base ref.
    pub fn base_content(&self, path: &str) -> Option<String> {
        diff::show_at_ref(&self.root, &self.mode.base_ref(), path)
    }

    /// Changed files worth analyzing: skips deleted, generated, vendored,
    /// lockfile, and minified paths (cheapest, biggest noise-control win).
    pub fn reviewable_files(&self) -> impl Iterator<Item = &ChangedFile> {
        self.files
            .iter()
            .filter(|f| !f.is_deleted && !is_generated(&f.path))
    }
}

/// A deterministic finding producer.
pub trait Collector {
    fn name(&self) -> &'static str;
    fn run(&self, ctx: &ReviewContext) -> Vec<crate::model::Finding>;
}

/// Generated / vendored / lockfile / minified paths we never deeply review.
pub fn is_generated(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    const DIR_MARKERS: &[&str] = &[
        "node_modules/",
        "/dist/",
        "dist/",
        "/build/",
        "build/",
        "/vendor/",
        "vendor/",
        "/.next/",
        "/target/",
        "target/",
        "/__generated__/",
        "/generated/",
        ".min.",
    ];
    const LOCKFILES: &[&str] = &[
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lock",
        "bun.lockb",
        "cargo.lock",
        "poetry.lock",
        "composer.lock",
        "gemfile.lock",
        "go.sum",
    ];
    if DIR_MARKERS.iter().any(|m| p.contains(m)) {
        return true;
    }
    let base = p.rsplit('/').next().unwrap_or(&p);
    LOCKFILES.contains(&base)
}

/// Language guessed from a file extension (drives language-gated rules).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    TypeScript,
    JavaScript,
    Tsx,
    Jsx,
    Python,
    Go,
    Rust,
    Java,
    Ruby,
    Other,
}

impl Lang {
    pub fn from_path(path: &str) -> Lang {
        let ext = path.rsplit('.').next().unwrap_or("");
        match ext {
            "ts" => Lang::TypeScript,
            "tsx" => Lang::Tsx,
            "mts" | "cts" => Lang::TypeScript,
            "js" | "mjs" | "cjs" => Lang::JavaScript,
            "jsx" => Lang::Jsx,
            "py" | "pyi" => Lang::Python,
            "go" => Lang::Go,
            "rs" => Lang::Rust,
            "java" => Lang::Java,
            "rb" => Lang::Ruby,
            _ => Lang::Other,
        }
    }

    pub fn is_jsish(self) -> bool {
        matches!(
            self,
            Lang::TypeScript | Lang::JavaScript | Lang::Tsx | Lang::Jsx
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_generated_paths() {
        assert!(is_generated("node_modules/foo/index.js"));
        assert!(is_generated("dist/bundle.min.js"));
        assert!(is_generated("package-lock.json"));
        assert!(is_generated("a/b/pnpm-lock.yaml"));
        assert!(!is_generated("src/api/users.ts"));
    }

    #[test]
    fn lang_detection() {
        assert_eq!(Lang::from_path("src/a.ts"), Lang::TypeScript);
        assert_eq!(Lang::from_path("src/a.py"), Lang::Python);
        assert!(Lang::from_path("a.tsx").is_jsish());
    }
}
