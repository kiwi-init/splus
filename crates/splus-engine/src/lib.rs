//! Splus deterministic review engine (library).
//!
//! Pipeline: git diff → clean-as-you-code changed set → deterministic collectors
//! → diff-filter/dedup/severity-sort → canonical Findings. Zero inference.

pub mod analysis;
pub mod collectors;
pub mod diff;
pub mod inspect;
pub mod model;
pub mod pipeline;
pub mod render;
pub mod util;

use collectors::Collector;

/// The tree-sitter analysis tier. Cross-file **blast radius** is grounded signal
/// and runs whenever circuit breakers allow. Cognitive-**complexity** delta is a
/// maintainability *metric* (near-zero bug correlation) — quiet by default; it is
/// only added when `metrics` is requested, so the review floor stays signal-only.
pub fn deep_collectors_impl(metrics: bool) -> Vec<Box<dyn Collector>> {
    let mut cs: Vec<Box<dyn Collector>> =
        vec![Box::new(collectors::blast_radius::BlastRadiusCollector)];
    if metrics {
        cs.push(Box::new(collectors::complexity::Complexity));
    }
    cs
}

/// Best-effort external adapters (semgrep/ast-grep/gitleaks/osv) that are NOT
/// installed — surfaced in the summary so we're honest about coverage gaps.
pub fn collectors_external_absent() -> Vec<String> {
    collectors::external::absent()
}
