//! Blast-radius collector (the moat). For each changed, exported, impactful
//! symbol, compute who depends on it cross-file and surface high-impact changes.
//! Every claim carries an explicit resolution-confidence — we never present a
//! name+import heuristic as compiler-grade truth.

use super::{Collector, Lang, ReviewContext};
use crate::analysis::graph::RepoGraph;
use crate::analysis::symbols::{self};
use crate::analysis::tslang;
use crate::model::{Anchor, AnchorKind, BlastRadius, Category, Finding, Region, Severity};

/// Only surface a change as "high impact" at/above this many direct callers
/// (or if it crosses an API boundary). Keeps the signal high.
const MIN_CALLERS: usize = 3;

/// Honest confidence for the v1 name+import heuristic over JS/TS.
const RESOLUTION_CONFIDENCE: f32 = 0.6;

pub struct BlastRadiusCollector;

impl Collector for BlastRadiusCollector {
    fn name(&self) -> &'static str {
        "blast-radius"
    }

    fn run(&self, ctx: &ReviewContext) -> Vec<Finding> {
        // Only meaningful for the JS/TS family (where our resolver works).
        let has_jsish = ctx
            .reviewable_files()
            .any(|f| Lang::from_path(&f.path).is_jsish());
        if !has_jsish {
            return Vec::new();
        }

        let graph = RepoGraph::build(&ctx.root);
        let mut out = Vec::new();

        for file in ctx.reviewable_files() {
            let lang = Lang::from_path(&file.path);
            if !lang.is_jsish() || !tslang::is_supported(lang) {
                continue;
            }
            let Some(src) = ctx.head_content(&file.path) else {
                continue;
            };
            let (syms, _imports) = symbols::extract(lang, &src);

            for s in &syms {
                if !s.exported || !s.kind.is_impactful() {
                    continue;
                }
                // Only symbols actually touched by this change.
                if file
                    .added_set
                    .range(s.start_line..=s.end_line)
                    .next()
                    .is_none()
                {
                    continue;
                }

                let info = graph.callers_of(&s.name, &file.path);
                if info.direct.len() < MIN_CALLERS && !info.crosses_api {
                    continue;
                }
                if info.direct.is_empty() {
                    continue; // crosses_api but nobody imports it yet — skip noise
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
                    &file.path,
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
                    // Our confidence the change is high-impact == resolution conf.
                    RESOLUTION_CONFIDENCE,
                    "blast-radius",
                    &format!("{}::{}", file.path, s.name),
                );
                finding.blast_radius = Some(BlastRadius {
                    symbol: s.name.clone(),
                    direct_callers: info.direct.len() as u32,
                    transitive_callers: info.transitive as u32,
                    files_affected: affected,
                    crosses_api_boundary: info.crosses_api,
                    resolution_confidence: RESOLUTION_CONFIDENCE,
                    resolution_method: "name+import heuristic (ts/js)".to_string(),
                });
                out.push(finding);
            }
        }
        out
    }
}
