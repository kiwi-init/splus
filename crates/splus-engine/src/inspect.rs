//! On-demand code intelligence — the engine "on tap".
//!
//! Where `review` pushes a finding floor, `inspect` lets the agent in the chair
//! *pull* one deterministic signal at a time while it investigates: who calls a
//! symbol, where it's defined, its blast radius, a file's complexity / exports /
//! imports. Every kind reuses an analysis the review pipeline already computes —
//! this module only re-exposes them as addressable, single-question queries.
//!
//! Resolution is the JS/TS name+import heuristic (same honest, known-confidence
//! tier as blast radius); the SCIP precise tier is used for `blast_radius` when an
//! index is present. Non-JS/TS targets resolve to an empty, honest answer.

use crate::analysis::graph::RepoGraph;
use crate::analysis::complexity::function_complexities;
use crate::analysis::scip::ScipGraph;
use crate::analysis::symbols::{self, Symbol};
use crate::collectors::Lang;
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// The questions a reviewer can ask the engine on demand.
pub const KINDS: &[&str] = &[
    "definition",
    "callers",
    "blast_radius",
    "complexity",
    "exports",
    "imports",
];

/// Answer one `inspect` query as canonical JSON.
///
/// `target` is a **symbol** for `definition` / `callers` / `blast_radius` and a
/// **file path** for `complexity` / `exports` / `imports`. `file` optionally pins
/// the defining file for a symbol query (disambiguates same-named symbols).
pub fn inspect(
    root: &Path,
    kind: &str,
    target: &str,
    file: Option<&str>,
    scip_path: Option<&Path>,
) -> Result<Value> {
    match kind {
        "definition" => Ok(definition(root, target)),
        "callers" => Ok(callers(root, target, file)),
        "blast_radius" => Ok(blast_radius(root, target, file, scip_path)),
        "complexity" => complexity(root, target),
        "exports" => exports(root, target),
        "imports" => imports(root, target),
        other => bail!("unknown --kind: {other} (use {})", KINDS.join("|")),
    }
}

// --- symbol queries (JS/TS name heuristic) ---------------------------------

/// Every definition of `name` across the indexed JS/TS surface.
fn definition(root: &Path, name: &str) -> Value {
    let g = RepoGraph::build(root);
    let defs = definitions(&g, root, name);
    json!({
        "kind": "definition",
        "symbol": name,
        "definitions": defs.iter().map(|(f, s)| json!({
            "file": f,
            "kind": s.kind.as_str(),
            "line": s.start_line,
            "exported": s.exported,
        })).collect::<Vec<_>>(),
        "note": resolution_note(&g),
    })
}

/// Files that import `name` from its defining file (direct + transitive count).
fn callers(root: &Path, name: &str, file: Option<&str>) -> Value {
    let g = RepoGraph::build(root);
    let Some(def_file) = resolve_def_file(&g, root, name, file) else {
        return not_found(&g, name);
    };
    let info = g.callers_of(name, &def_file);
    json!({
        "kind": "callers",
        "symbol": name,
        "defFile": def_file,
        "directCallers": info.direct,
        "transitiveCallers": info.transitive,
        "crossesApiBoundary": info.crosses_api,
        "note": resolution_note(&g),
    })
}

/// Full blast radius for `name` — SCIP-precise when an index is loaded, else the
/// name+import heuristic, always with an honest `resolutionConfidence`/`method`.
fn blast_radius(root: &Path, name: &str, file: Option<&str>, scip_path: Option<&Path>) -> Value {
    let g = RepoGraph::build(root);
    let Some(def_file) = resolve_def_file(&g, root, name, file) else {
        return not_found(&g, name);
    };

    // Precise tier: resolve via the symbol's definition line against the SCIP index.
    if let Some(scip) = scip_path.and_then(ScipGraph::load) {
        if let Some(def_line) = def_line_of(&g, root, name, &def_file) {
            if let Some(pc) = scip.resolve(&def_file, def_line, name) {
                return json!({
                    "kind": "blast_radius",
                    "symbol": name,
                    "defFile": def_file,
                    "directCallers": pc.direct.len(),
                    "transitiveCallers": pc.total_refs,
                    "filesAffected": pc.direct,
                    "crossesApiBoundary": pc.crosses_api,
                    "resolutionConfidence": 0.97,
                    "resolutionMethod": "scip (compiler-grade)",
                });
            }
        }
    }

    let info = g.callers_of(name, &def_file);
    json!({
        "kind": "blast_radius",
        "symbol": name,
        "defFile": def_file,
        "directCallers": info.direct.len(),
        "transitiveCallers": info.transitive,
        "filesAffected": info.direct,
        "crossesApiBoundary": info.crosses_api,
        "resolutionConfidence": 0.6,
        "resolutionMethod": "name+import heuristic (TS/JS)",
    })
}

// --- file queries ----------------------------------------------------------

/// Cognitive complexity per function in a file (optionally one function).
fn complexity(root: &Path, file: &str) -> Result<Value> {
    let src = read_file(root, file)?;
    let mut fns = function_complexities(Lang::from_path(file), &src);
    fns.sort_by(|a, b| b.score.cmp(&a.score));
    let max = fns.iter().map(|f| f.score).max().unwrap_or(0);
    Ok(json!({
        "kind": "complexity",
        "file": file,
        "max": max,
        "functions": fns.iter().map(|f| json!({
            "name": f.name,
            "startLine": f.start_line,
            "endLine": f.end_line,
            "score": f.score,
        })).collect::<Vec<_>>(),
    }))
}

/// Exported symbols of a file.
fn exports(root: &Path, file: &str) -> Result<Value> {
    let src = read_file(root, file)?;
    let (syms, _) = symbols::extract(Lang::from_path(file), &src);
    Ok(json!({
        "kind": "exports",
        "file": file,
        "exports": syms.iter().filter(|s| s.exported).map(|s| json!({
            "name": s.name,
            "kind": s.kind.as_str(),
            "line": s.start_line,
        })).collect::<Vec<_>>(),
    }))
}

/// Import statements of a file.
fn imports(root: &Path, file: &str) -> Result<Value> {
    let src = read_file(root, file)?;
    let (_, imps) = symbols::extract(Lang::from_path(file), &src);
    Ok(json!({
        "kind": "imports",
        "file": file,
        "imports": imps.iter().map(|i| json!({
            "names": i.names,
            "source": i.source,
        })).collect::<Vec<_>>(),
    }))
}

// --- helpers ---------------------------------------------------------------

fn read_file(root: &Path, file: &str) -> Result<String> {
    let full = root.join(file);
    fs::read_to_string(&full)
        .map_err(|e| anyhow::anyhow!("cannot read {}: {e}", full.display()))
}

/// All `(file, Symbol)` definitions of `name` across the indexed JS/TS files.
fn definitions(g: &RepoGraph, root: &Path, name: &str) -> Vec<(String, Symbol)> {
    let mut files: Vec<&String> = g.files.iter().collect();
    files.sort();
    let mut out = Vec::new();
    for f in files {
        if let Ok(src) = fs::read_to_string(root.join(f)) {
            for s in symbols::extract(Lang::from_path(f), &src).0 {
                if s.name == name {
                    out.push((f.clone(), s));
                }
            }
        }
    }
    out
}

/// Pick the defining file for a symbol: the caller's `file` hint if it actually
/// defines `name`, else the first exported definition, else the first definition.
fn resolve_def_file(g: &RepoGraph, root: &Path, name: &str, file: Option<&str>) -> Option<String> {
    let defs = definitions(g, root, name);
    if let Some(hint) = file {
        if defs.iter().any(|(f, _)| f == hint) {
            return Some(hint.to_string());
        }
    }
    defs.iter()
        .find(|(_, s)| s.exported)
        .or_else(|| defs.first())
        .map(|(f, _)| f.clone())
}

fn def_line_of(g: &RepoGraph, root: &Path, name: &str, def_file: &str) -> Option<u32> {
    definitions(g, root, name)
        .into_iter()
        .find(|(f, _)| f == def_file)
        .map(|(_, s)| s.start_line)
}

fn not_found(g: &RepoGraph, name: &str) -> Value {
    json!({
        "kind": "not_found",
        "symbol": name,
        "definitions": [],
        "note": format!("No definition of `{name}` found in the indexed surface. {}", resolution_note(g)),
    })
}

fn resolution_note(g: &RepoGraph) -> String {
    let mut note = format!(
        "Heuristic graph over {} JS/TS file(s); non-JS/TS symbols are not resolved here.",
        g.indexed
    );
    if g.truncated {
        note.push_str(" Index truncated at the file cap — results may be partial.");
    }
    note
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write(dir: &Path, path: &str, src: &str) {
        let full = dir.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, src).unwrap();
    }

    fn fixture() -> tempfile::TempDir {
        let d = tempdir().unwrap();
        let r = d.path();
        write(r, "src/utils/auth.ts", "export function validateToken(t){ return !!t; }\nfunction helper(){ return 1; }\n");
        write(r, "src/api/login.ts", "import { validateToken } from '../utils/auth';\nexport function login(){ return validateToken('y'); }\n");
        d
    }

    #[test]
    fn definition_finds_exported_symbol() {
        let d = fixture();
        let v = inspect(d.path(), "definition", "validateToken", None, None).unwrap();
        let defs = v["definitions"].as_array().unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0]["file"], "src/utils/auth.ts");
        assert_eq!(defs[0]["exported"], true);
    }

    #[test]
    fn callers_finds_importer_across_api_boundary() {
        let d = fixture();
        let v = inspect(d.path(), "callers", "validateToken", None, None).unwrap();
        assert_eq!(v["directCallers"].as_array().unwrap().len(), 1);
        assert_eq!(v["crossesApiBoundary"], true);
    }

    #[test]
    fn blast_radius_is_honest_without_scip() {
        let d = fixture();
        let v = inspect(d.path(), "blast_radius", "validateToken", None, None).unwrap();
        assert_eq!(v["resolutionMethod"], "name+import heuristic (TS/JS)");
        assert_eq!(v["directCallers"], 1);
    }

    #[test]
    fn exports_lists_only_exported() {
        let d = fixture();
        let v = inspect(d.path(), "exports", "src/utils/auth.ts", None, None).unwrap();
        let ex = v["exports"].as_array().unwrap();
        assert_eq!(ex.len(), 1);
        assert_eq!(ex[0]["name"], "validateToken");
    }

    #[test]
    fn imports_lists_specifiers() {
        let d = fixture();
        let v = inspect(d.path(), "imports", "src/api/login.ts", None, None).unwrap();
        let im = v["imports"].as_array().unwrap();
        assert_eq!(im.len(), 1);
        assert_eq!(im[0]["source"], "../utils/auth");
    }

    #[test]
    fn unknown_symbol_is_honest_not_found() {
        let d = fixture();
        let v = inspect(d.path(), "callers", "nope", None, None).unwrap();
        assert_eq!(v["kind"], "not_found");
    }
}
