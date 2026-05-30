//! Cognitive-complexity DELTA collector. The signal isn't the absolute number —
//! it's "this function got much harder to understand in this change". We match
//! functions base↔head by name and only flag touched functions that cross the
//! threshold or jump significantly. Maintainability, never claimed as a bug.

use super::{Collector, Lang, ReviewContext};
use crate::analysis::complexity::{function_complexities, FnComplexity};
use crate::analysis::tslang;
use crate::model::{Anchor, AnchorKind, Category, Finding, Region, Severity};
use std::collections::HashMap;

/// Sonar's default "too complex" threshold.
const COMPLEX_THRESHOLD: u32 = 15;
/// Minimum increase to bother reporting on an already-changed function.
const DELTA_MIN: u32 = 5;
/// A big jump is worth noting even below the absolute threshold.
const BIG_JUMP: u32 = 10;

pub struct Complexity;

impl Collector for Complexity {
    fn name(&self) -> &'static str {
        "complexity"
    }

    fn run(&self, ctx: &ReviewContext) -> Vec<Finding> {
        let mut out = Vec::new();
        for file in ctx.reviewable_files() {
            let lang = Lang::from_path(&file.path);
            if !tslang::is_supported(lang) {
                continue;
            }
            let Some(head_src) = ctx.head_content(&file.path) else {
                continue;
            };
            let head_fns = function_complexities(lang, &head_src);
            if head_fns.is_empty() {
                continue;
            }

            // Base complexity by name (first occurrence wins; good enough v1).
            let base_fns = ctx
                .base_content(&file.path)
                .map(|s| function_complexities(lang, &s))
                .unwrap_or_default();
            let base_by_name: HashMap<&str, u32> = {
                let mut m = HashMap::new();
                for f in &base_fns {
                    m.entry(f.name.as_str()).or_insert(f.score);
                }
                m
            };

            for f in &head_fns {
                // Only consider functions actually touched by this change.
                if !touches_added(file, f) {
                    continue;
                }
                let base = base_by_name.get(f.name.as_str()).copied();
                let decision = classify(f.score, base);
                let Some((severity, headline)) = decision else {
                    continue;
                };

                let detail = match base {
                    Some(b) => format!("cognitive complexity {b} → {} (+{})", f.score, f.score - b),
                    None => format!("cognitive complexity {} (new function)", f.score),
                };
                let msg = format!(
                    "{headline} {detail}. Consider extracting helpers or reducing nesting to keep it reviewable. (Maintainability signal, not a bug.)"
                );
                out.push(Finding::new(
                    "maintainability.cognitive-complexity",
                    Category::Maintainability,
                    severity,
                    &file.path,
                    Region::line(f.start_line),
                    "High cognitive complexity",
                    &msg,
                    Anchor {
                        kind: AnchorKind::Metric,
                        detail: detail.clone(),
                    },
                    0.85,
                    "complexity",
                    // Fingerprint on function name (stable across line shifts).
                    &format!("{}::{}", file.path, f.name),
                ));
            }
        }
        out
    }
}

/// Does the function's line range intersect any added (clean-as-you-code) line?
fn touches_added(file: &crate::model::ChangedFile, f: &FnComplexity) -> bool {
    file.added_set
        .range(f.start_line..=f.end_line)
        .next()
        .is_some()
}

/// Decide whether (and how severely) to report a function's complexity.
fn classify(head: u32, base: Option<u32>) -> Option<(Severity, &'static str)> {
    match base {
        None => {
            // New function.
            if head >= COMPLEX_THRESHOLD * 2 {
                Some((Severity::Medium, "New function with very high"))
            } else if head >= COMPLEX_THRESHOLD {
                Some((Severity::Low, "New function with high"))
            } else {
                None
            }
        }
        Some(b) => {
            let delta = head.saturating_sub(b);
            if head >= COMPLEX_THRESHOLD && delta >= DELTA_MIN {
                let sev = if head >= COMPLEX_THRESHOLD * 2 || delta >= 15 {
                    Severity::Medium
                } else {
                    Severity::Low
                };
                Some((sev, "Rising"))
            } else if delta >= BIG_JUMP {
                Some((Severity::Low, "Sharp jump in"))
            } else {
                None
            }
        }
    }
}
