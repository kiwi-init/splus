//! Splus deterministic review engine (library).
//!
//! Pipeline: git diff → clean-as-you-code changed set → deterministic collectors
//! → diff-filter/dedup/severity-sort → canonical Findings. Zero inference.

pub mod analysis;
pub mod collectors;
pub mod diff;
pub mod model;
pub mod pipeline;
pub mod render;
pub mod util;

use collectors::Collector;

/// The tree-sitter analysis tier: cognitive-complexity delta + cross-file
/// blast radius. Runs only when circuit breakers allow (see pipeline).
pub fn deep_collectors_impl() -> Vec<Box<dyn Collector>> {
    vec![
        Box::new(collectors::complexity::Complexity),
        Box::new(collectors::blast_radius::BlastRadiusCollector),
    ]
}

/// Best-effort external adapters (semgrep/ast-grep/gitleaks/osv) that are NOT
/// installed — surfaced in the summary so we're honest about coverage gaps.
pub fn collectors_external_absent() -> Vec<String> {
    collectors::external::absent()
}
