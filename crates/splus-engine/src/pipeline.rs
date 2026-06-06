//! Review orchestration: circuit breakers → collectors → diff-filter → dedup →
//! severity sort → summary. The deterministic spine.

use crate::collectors::external::External;
use crate::collectors::heuristics::Heuristics;
use crate::collectors::secrets::Secrets;
use crate::collectors::{Collector, ReviewContext};
use crate::diff::{self, DiffMode};
use crate::model::{Finding, Report, Summary, Tier};
use anyhow::Result;
use std::collections::HashSet;
use std::path::PathBuf;

/// Circuit breakers (red-team requirement): bound cost/latency on huge PRs.
pub const MAX_FILES: usize = 600;
pub const MAX_ADDED_LINES: usize = 30_000;

pub struct Engine {
    pub root: PathBuf,
    pub mode: DiffMode,
    /// When true, run the (heavier) tree-sitter analysis tier.
    pub deep: bool,
    /// When true, also emit cognitive-complexity maintainability metrics. On by
    /// default (zero config) — the delta-only scoring keeps them quiet on
    /// unchanged code; disable with `--no-metrics`.
    pub metrics: bool,
    /// Explicit path to a SCIP index for the precise blast-radius tier.
    /// When None, the engine auto-detects `index.scip` / `.splus-cache/index.scip`.
    pub scip_path: Option<PathBuf>,
}

impl Engine {
    pub fn new(root: PathBuf, mode: DiffMode) -> Engine {
        Engine { root, mode, deep: true, metrics: true, scip_path: None }
    }

    /// Resolve the SCIP index path: explicit override, else conventional locations.
    fn resolve_scip(&self) -> Option<PathBuf> {
        if let Some(p) = &self.scip_path {
            return p.exists().then(|| p.clone());
        }
        for cand in ["index.scip", ".splus-cache/index.scip"] {
            let p = self.root.join(cand);
            if p.exists() {
                return Some(p);
            }
        }
        None
    }

    pub fn review(&self) -> Result<Report> {
        let patch = diff::diff_patch(&self.root, &self.mode)?;
        let files = diff::parse_unified_diff(&patch);

        let files_changed = files.len() as u32;
        let added_lines: usize = files.iter().map(|f| f.added.len()).sum();

        let mut notes: Vec<String> = Vec::new();
        let mut run_deep = self.deep;

        // --- circuit breakers ---
        if files.len() > MAX_FILES {
            notes.push(format!(
                "Large change: {} files (> {} cap). Ran fast collectors only; skipped deep cross-file analysis.",
                files.len(),
                MAX_FILES
            ));
            run_deep = false;
        }
        if added_lines > MAX_ADDED_LINES {
            notes.push(format!(
                "Large change: {} added lines (> {} cap). Ran fast collectors only.",
                added_lines, MAX_ADDED_LINES
            ));
            run_deep = false;
        }

        // Load the SCIP precise tier if an index is present.
        let scip = self.resolve_scip().and_then(|p| crate::analysis::scip::ScipGraph::load(&p));
        if let Some(g) = &scip {
            notes.push(format!(
                "SCIP precise tier active: {} indexed document(s) — cross-file impact is compiler-grade.",
                g.document_count
            ));
        }

        let ctx = ReviewContext {
            root: self.root.clone(),
            mode: self.mode.clone(),
            files,
            scip,
        };

        // Collector set. Fast collectors always run; deep (tree-sitter) tier is
        // appended by `deep_collectors` once that module lands.
        let mut collectors: Vec<Box<dyn Collector>> =
            vec![Box::new(Secrets), Box::new(Heuristics), Box::new(External)];
        if run_deep {
            collectors.extend(deep_collectors(self.metrics));
        }

        let mut findings: Vec<Finding> = Vec::new();
        let mut collectors_run: Vec<String> = Vec::new();
        for c in &collectors {
            collectors_run.push(c.name().to_string());
            findings.extend(c.run(&ctx));
        }

        // Dedup by stable fingerprint.
        let mut seen: HashSet<String> = HashSet::new();
        findings.retain(|f| seen.insert(f.id.clone()));

        // Sort: most severe first, then file, then line.
        findings.sort_by(|a, b| {
            b.severity
                .rank()
                .cmp(&a.severity.rank())
                .then_with(|| a.file.cmp(&b.file))
                .then_with(|| a.region.start_line.cmp(&b.region.start_line))
        });

        let must_fix = findings.iter().filter(|f| f.tier == Tier::MustFix).count();
        let concern = findings.iter().filter(|f| f.tier == Tier::Concern).count();
        let nit = findings.iter().filter(|f| f.tier == Tier::Nit).count();

        let summary = Summary {
            files_changed,
            added_lines: added_lines as u32,
            findings_total: findings.len(),
            must_fix,
            concern,
            nit,
            suppressed: 0,
            collectors_run,
            adapters_absent: crate::collectors_external_absent(),
            notes,
        };

        Ok(Report {
            tool: "splus".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            summary,
            findings,
        })
    }
}

/// Tree-sitter / external collectors are wired in later steps. Keeping this as a
/// single seam means the pipeline never changes when we add analysis depth.
fn deep_collectors(metrics: bool) -> Vec<Box<dyn Collector>> {
    crate::deep_collectors_impl(metrics)
}
