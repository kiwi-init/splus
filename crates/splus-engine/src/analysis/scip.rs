//! SCIP precise tier — read a compiler-grade `index.scip` (Sourcegraph Code
//! Intelligence Protocol) and resolve cross-file references EXACTLY.
//!
//! This is the moat's precision upgrade: where an index is available (produced
//! out-of-band by scip-typescript / scip-python and cached per default-branch
//! commit — never on the synchronous PR path), we replace the name+import
//! heuristic with the real def→reference graph. If SCIP resolves a symbol we
//! trust it fully: an empty caller set is *precise knowledge* that nothing
//! references it, not a reason to fall back and guess.
//!
//! We hand-declare the minimal SCIP message subset; prost skips unknown fields,
//! so there is no protoc / build.rs dependency.

use prost::Message;
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;

// --- minimal SCIP schema (field tags are from scip.proto) ---

#[derive(Clone, PartialEq, ::prost::Message)]
struct PbIndex {
    #[prost(message, repeated, tag = "2")]
    documents: Vec<PbDocument>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct PbDocument {
    #[prost(string, tag = "1")]
    relative_path: String,
    #[prost(message, repeated, tag = "2")]
    occurrences: Vec<PbOccurrence>,
    // Decoded for completeness; not read by the resolver.
    #[prost(string, tag = "4")]
    #[allow(dead_code)]
    language: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct PbOccurrence {
    #[prost(int32, repeated, tag = "1")]
    range: Vec<i32>,
    #[prost(string, tag = "2")]
    symbol: String,
    #[prost(int32, tag = "3")]
    symbol_roles: i32,
}

/// SymbolRole.Definition bit.
const ROLE_DEFINITION: i32 = 0x1;

#[derive(Debug, Clone)]
struct Occ {
    file: String,
    is_def: bool,
}

/// A loaded, queryable SCIP index.
pub struct ScipGraph {
    by_symbol: HashMap<String, Vec<Occ>>,
    /// (file, 1-indexed line) -> symbols defined there.
    defs_at: HashMap<(String, u32), Vec<String>>,
    pub document_count: usize,
}

/// Compiler-grade caller set for a changed symbol.
#[derive(Debug, Clone)]
pub struct PreciseCallers {
    /// Files that reference the symbol (excluding its defining file).
    pub direct: Vec<String>,
    /// Total reference occurrences (may exceed file count).
    pub total_refs: u32,
    pub crosses_api: bool,
}

impl ScipGraph {
    pub fn load(path: &Path) -> Option<ScipGraph> {
        let bytes = fs::read(path).ok()?;
        let index = PbIndex::decode(&bytes[..]).ok()?;
        Some(Self::from_index(index))
    }

    fn from_index(index: PbIndex) -> ScipGraph {
        let mut by_symbol: HashMap<String, Vec<Occ>> = HashMap::new();
        let mut defs_at: HashMap<(String, u32), Vec<String>> = HashMap::new();

        for doc in &index.documents {
            let file = doc.relative_path.replace('\\', "/");
            for occ in &doc.occurrences {
                // `local …` symbols are document-scoped — never cross-file.
                if occ.symbol.is_empty() || occ.symbol.starts_with("local ") {
                    continue;
                }
                let line = occ.range.first().copied().unwrap_or(0).max(0) as u32 + 1;
                let is_def = occ.symbol_roles & ROLE_DEFINITION != 0;
                by_symbol
                    .entry(occ.symbol.clone())
                    .or_default()
                    .push(Occ { file: file.clone(), is_def });
                if is_def {
                    defs_at.entry((file.clone(), line)).or_default().push(occ.symbol.clone());
                }
            }
        }

        ScipGraph { by_symbol, defs_at, document_count: index.documents.len() }
    }

    /// Resolve a changed symbol (by file + definition line + name) to its precise
    /// callers. Returns None ONLY if the symbol isn't in the index (→ caller may
    /// fall back to the heuristic). `Some(direct = [])` means the index proves it
    /// has no external references.
    pub fn resolve(&self, file: &str, def_line: u32, name: &str) -> Option<PreciseCallers> {
        let sym = self.symbol_at(file, def_line, name)?;
        let occs = self.by_symbol.get(&sym)?;

        let mut files = BTreeSet::new();
        let mut total = 0u32;
        for o in occs {
            if o.is_def {
                continue;
            }
            total += 1;
            if o.file != file {
                files.insert(o.file.clone());
            }
        }
        let direct: Vec<String> = files.into_iter().collect();
        let crosses_api = is_api(file) || direct.iter().any(|f| is_api(f));
        Some(PreciseCallers { direct, total_refs: total, crosses_api })
    }

    /// Find the SCIP symbol defined at (file, ~line) whose descriptor names `name`.
    /// Tolerates ±1 line drift between our declaration line and SCIP's identifier
    /// occurrence.
    fn symbol_at(&self, file: &str, def_line: u32, name: &str) -> Option<String> {
        for dl in [def_line, def_line.saturating_sub(1), def_line + 1] {
            if let Some(syms) = self.defs_at.get(&(file.to_string(), dl)) {
                if let Some(s) = syms.iter().find(|s| symbol_has_name(s, name)) {
                    return Some(s.clone());
                }
            }
        }
        None
    }
}

/// SCIP descriptors embed the name as a token (e.g. `… getUser().` or `… PORT.`).
fn symbol_has_name(symbol: &str, name: &str) -> bool {
    symbol.contains(name)
}

fn is_api(path: &str) -> bool {
    const B: &[&str] = &[
        "routes", "route", "api", "handlers", "controllers", "endpoints", "pages", "graphql", "resolvers",
    ];
    path.split('/').any(|seg| B.contains(&seg))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn occ(line: i32, symbol: &str, def: bool) -> PbOccurrence {
        PbOccurrence {
            range: vec![line, 0, line, 10],
            symbol: symbol.to_string(),
            symbol_roles: if def { ROLE_DEFINITION } else { 0 },
        }
    }

    #[test]
    fn resolves_precise_callers_and_round_trips_protobuf() {
        let sym = "scip-typescript npm . . `src/utils/auth.ts`/validateToken().";
        let index = PbIndex {
            documents: vec![
                PbDocument {
                    relative_path: "src/utils/auth.ts".into(),
                    language: "TypeScript".into(),
                    occurrences: vec![occ(0, sym, true)], // definition at line 0 (→ 1)
                },
                PbDocument {
                    relative_path: "src/api/login.ts".into(),
                    language: "TypeScript".into(),
                    occurrences: vec![occ(4, sym, false)], // a reference
                },
                PbDocument {
                    relative_path: "src/api/refresh.ts".into(),
                    language: "TypeScript".into(),
                    occurrences: vec![occ(7, sym, false), occ(9, sym, false)], // two refs, one file
                },
                PbDocument {
                    relative_path: "src/unrelated.ts".into(),
                    language: "TypeScript".into(),
                    occurrences: vec![occ(1, "local 1", false)], // ignored
                },
            ],
        };
        let bytes = index.encode_to_vec();
        let graph = ScipGraph::from_index(PbIndex::decode(&bytes[..]).unwrap());
        assert_eq!(graph.document_count, 4);

        // Our extractor reports validateToken's declaration at line 1.
        let pc = graph
            .resolve("src/utils/auth.ts", 1, "validateToken")
            .expect("symbol resolves precisely");
        assert_eq!(pc.direct, vec!["src/api/login.ts", "src/api/refresh.ts"]);
        assert_eq!(pc.total_refs, 3); // 1 + 2
        assert!(pc.crosses_api); // src/api/* is a boundary

        // A symbol not in the index → None (caller falls back to heuristic).
        assert!(graph.resolve("src/utils/auth.ts", 1, "doesNotExist").is_none());
    }

    #[test]
    fn empty_callers_is_precise_not_fallback() {
        let sym = "scip x . `a.ts`/internalHelper().";
        let index = PbIndex {
            documents: vec![PbDocument {
                relative_path: "src/a.ts".into(),
                language: "TypeScript".into(),
                occurrences: vec![occ(2, sym, true)], // defined, never referenced
            }],
        };
        let graph = ScipGraph::from_index(index);
        let pc = graph.resolve("src/a.ts", 3, "internalHelper").expect("resolves");
        assert!(pc.direct.is_empty(), "precise: proven to have no external callers");
    }
}
