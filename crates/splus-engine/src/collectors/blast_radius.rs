//! Blast-radius collector (the moat). Two-tier, precision-first:
//!
//!   1. PRECISE (SCIP) — when an index.scip is loaded and resolves the changed
//!      symbol, we use the real compiler-grade def→reference graph. An empty
//!      caller set is *precise knowledge*, not a fall-through.
//!   2. HEURISTIC (name + import path) — only for symbols SCIP can't resolve
//!      (no index, or a language/symbol the index doesn't cover). Lower,
//!      explicitly-labeled confidence.
//!
//! Every finding carries its resolution method + confidence — we never present
//! a heuristic blast radius as compiler-grade truth.

use super::{Collector, Lang, ReviewContext};
use crate::analysis::graph::RepoGraph;
use crate::analysis::scip::PreciseCallers;
use crate::analysis::symbols::{self, Symbol};
use crate::analysis::tslang;
use crate::model::{Anchor, AnchorKind, BlastRadius, Category, Finding, Region, Severity};

/// Surface a change as "high impact" at/above this many caller files, or when it
/// crosses an API boundary. Keeps the signal high.
const MIN_CALLERS: usize = 3;

const HEURISTIC_CONFIDENCE: f32 = 0.6;
const PRECISE_CONFIDENCE: f32 = 0.97;

pub struct BlastRadiusCollector;

impl Collector for BlastRadiusCollector {
    fn name(&self) -> &'static str {
        "blast-radius"
    }

    fn run(&self, ctx: &ReviewContext) -> Vec<Finding> {
        let scip = ctx.scip.as_ref();
        let mut out: Vec<Finding> = Vec::new();
        // Symbols SCIP couldn't resolve → resolved later by the heuristic graph.
        let mut fallback: Vec<(String, Symbol)> = Vec::new();

        for file in ctx.reviewable_files() {
            let lang = Lang::from_path(&file.path);
            // The name+import heuristic graph only models JS/TS module resolution;
            // SCIP resolves any indexed language. So a file is usable when it's
            // JS/TS (heuristic) or when a SCIP index is loaded (precise, any of the
            // deeply-supported languages — Go, Rust, Java, …).
            let usable = lang.is_jsish() || scip.is_some();
            if !usable || !tslang::is_supported(lang) {
                continue;
            }
            let Some(src) = ctx.head_content(&file.path) else {
                continue;
            };
            let (syms, _imports) = symbols::extract(lang, &src);

            for s in syms {
                if !s.exported || !s.kind.is_impactful() {
                    continue;
                }
                if file.added_set.range(s.start_line..=s.end_line).next().is_none() {
                    continue; // not touched by this change
                }

                // --- precise tier: if SCIP resolves it, trust fully (no fallback) ---
                if let Some(g) = scip {
                    if let Some(pc) = g.resolve(&file.path, s.start_line, &s.name) {
                        if let Some(f) = precise_finding(&file.path, &s, &pc) {
                            out.push(f);
                        }
                        continue;
                    }
                }

                // --- heuristic fallback (JS/TS only) ---
                if lang.is_jsish() {
                    fallback.push((file.path.clone(), s));
                }
            }
        }

        if !fallback.is_empty() {
            let graph = RepoGraph::build(&ctx.root);
            for (path, s) in fallback {
                if let Some(f) = heuristic_finding(&graph, &path, &s) {
                    out.push(f);
                }
            }
        }

        out
    }
}

fn precise_finding(file: &str, s: &Symbol, pc: &PreciseCallers) -> Option<Finding> {
    if pc.direct.len() < MIN_CALLERS && !(pc.crosses_api && !pc.direct.is_empty()) {
        return None; // resolved, but not high-impact enough to surface
    }
    let severity = if pc.direct.len() >= 8 || pc.crosses_api {
        Severity::Medium
    } else {
        Severity::Low
    };
    let mut affected = pc.direct.clone();
    affected.truncate(12);

    let msg = format!(
        "Changing exported `{}` ({}) is referenced by {} file(s) — {} reference site(s), resolved compiler-grade{}. Verify those call sites and their tests before merging.",
        s.name,
        s.kind.as_str(),
        pc.direct.len(),
        pc.total_refs,
        if pc.crosses_api { ", and it crosses an API/route boundary" } else { "" }
    );

    let mut finding = Finding::new(
        "impact.blast-radius",
        Category::Impact,
        severity,
        file,
        Region::line(s.start_line),
        "High-impact change",
        &msg,
        Anchor {
            kind: AnchorKind::GraphEdge,
            detail: format!("{} reference site(s) across {} file(s) (scip, compiler-grade)", pc.total_refs, pc.direct.len()),
        },
        PRECISE_CONFIDENCE,
        "blast-radius",
        &format!("{}::{}", file, s.name),
    );
    finding.blast_radius = Some(BlastRadius {
        symbol: s.name.clone(),
        direct_callers: pc.direct.len() as u32,
        transitive_callers: 0,
        files_affected: affected,
        crosses_api_boundary: pc.crosses_api,
        resolution_confidence: PRECISE_CONFIDENCE,
        resolution_method: "scip (compiler-grade)".to_string(),
    });
    Some(finding)
}

fn heuristic_finding(graph: &RepoGraph, file: &str, s: &Symbol) -> Option<Finding> {
    let info = graph.callers_of(&s.name, file);
    if info.direct.len() < MIN_CALLERS && !info.crosses_api {
        return None;
    }
    if info.direct.is_empty() {
        return None; // crosses_api but nobody imports it yet — skip noise
    }

    let severity = if info.direct.len() >= 8 || info.crosses_api {
        Severity::Medium
    } else {
        Severity::Low
    };
    let mut affected = info.direct.clone();
    affected.truncate(12);

    let msg = format!(
        "Changing exported `{}` ({}) impacts {} direct and ~{} transitive caller(s){}. Verify those call sites and their tests before merging.",
        s.name,
        s.kind.as_str(),
        info.direct.len(),
        info.transitive,
        if info.crosses_api { ", and it crosses an API/route boundary" } else { "" }
    );

    let mut finding = Finding::new(
        "impact.blast-radius",
        Category::Impact,
        severity,
        file,
        Region::line(s.start_line),
        "High-impact change",
        &msg,
        Anchor {
            kind: AnchorKind::GraphEdge,
            detail: format!(
                "{} direct / {} transitive caller(s) (name+import heuristic)",
                info.direct.len(),
                info.transitive
            ),
        },
        HEURISTIC_CONFIDENCE,
        "blast-radius",
        &format!("{}::{}", file, s.name),
    );
    finding.blast_radius = Some(BlastRadius {
        symbol: s.name.clone(),
        direct_callers: info.direct.len() as u32,
        transitive_callers: info.transitive as u32,
        files_affected: affected,
        crosses_api_boundary: info.crosses_api,
        resolution_confidence: HEURISTIC_CONFIDENCE,
        resolution_method: "name+import heuristic (ts/js)".to_string(),
    });
    Some(finding)
}
