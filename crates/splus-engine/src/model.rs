//! The canonical Finding model — the single shared vocabulary across the engine,
//! the CLI, and the GitHub App. Mirrored in TypeScript (packages/shared).

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    // Ordered most→least severe (derive(Ord) follows declaration order).
    Critical,
    High,
    Medium,
    Low,
    Info,
}

impl Severity {
    /// Numeric rank for `--fail-on` comparisons (higher = more severe).
    pub fn rank(self) -> u8 {
        match self {
            Severity::Critical => 4,
            Severity::High => 3,
            Severity::Medium => 2,
            Severity::Low => 1,
            Severity::Info => 0,
        }
    }

    pub fn parse(s: &str) -> Option<Severity> {
        match s.to_ascii_lowercase().as_str() {
            "critical" => Some(Severity::Critical),
            "high" => Some(Severity::High),
            "medium" => Some(Severity::Medium),
            "low" => Some(Severity::Low),
            "info" => Some(Severity::Info),
            _ => None,
        }
    }

    /// Severity → review tier. The tier is what the user reads; nits are
    /// collapsed/opt-in by default (precision-first).
    pub fn tier(self) -> Tier {
        match self {
            Severity::Critical | Severity::High => Tier::MustFix,
            Severity::Medium => Tier::Concern,
            Severity::Low | Severity::Info => Tier::Nit,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    MustFix,
    Concern,
    Nit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Security,
    Supplychain,
    Correctness,
    Maintainability,
    Hygiene,
    Impact,
}

/// Provenance of a finding. Every finding cites *what grounds it* — this is the
/// auditable anchor. NOTE: an anchor is provenance, not a correctness guarantee
/// (Semgrep/heuristic anchors can still be false positives). Precision is earned
/// downstream via suppression + the LLM judge, not by the anchor alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnchorKind {
    /// A SARIF result from an external engine (Semgrep, ast-grep, …).
    Sarif,
    /// An edge in the reference graph (caller/import/signature).
    GraphEdge,
    /// A computed metric crossing a threshold (cognitive complexity, …).
    Metric,
    /// A matched secret pattern (+ entropy).
    Secret,
    /// A known-vulnerable dependency (OSV/advisory).
    Vuln,
    /// A pure-syntax/regex heuristic (lowest trust by default).
    Heuristic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    pub kind: AnchorKind,
    /// Human-readable provenance, e.g. "semgrep:javascript.express.sqli" or
    /// "graph: 8 callers across 5 files".
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Region {
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

impl Region {
    pub fn line(line: u32) -> Region {
        Region { start_line: line, start_col: 0, end_line: line, end_col: 0 }
    }
}

/// Cross-file impact of a changed symbol (the moat). `resolution_confidence`
/// is mandatory and honest: name-based resolution is low-confidence; SCIP/LSP
/// would be high. We NEVER present a coarse blast radius as a certain fact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlastRadius {
    pub symbol: String,
    pub direct_callers: u32,
    pub transitive_callers: u32,
    pub files_affected: Vec<String>,
    pub crosses_api_boundary: bool,
    /// 0..1 — how sure we are the resolution is correct.
    pub resolution_confidence: f32,
    /// e.g. "name+import heuristic (TS/JS)", "scip (compiler-grade)".
    pub resolution_method: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    /// Stable fingerprint (survives line shifts). Used for dedup + suppression.
    pub id: String,
    pub rule_id: String,
    pub category: Category,
    pub severity: Severity,
    pub tier: Tier,
    /// 0..1 confidence this is a real, worth-flagging issue.
    pub confidence: f32,
    pub file: String,
    pub region: Region,
    pub title: String,
    pub message: String,
    pub anchor: Anchor,
    /// True if on a clean-as-you-code added line (new in this change).
    pub introduced: bool,
    /// Which collector produced it.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blast_radius: Option<BlastRadius>,
}

impl Finding {
    pub fn new(
        rule_id: &str,
        category: Category,
        severity: Severity,
        file: &str,
        region: Region,
        title: &str,
        message: &str,
        anchor: Anchor,
        confidence: f32,
        source: &str,
        snippet_key: &str,
    ) -> Finding {
        let id = crate::util::fingerprint(&[rule_id, file, snippet_key]);
        Finding {
            id,
            rule_id: rule_id.to_string(),
            category,
            severity,
            tier: severity.tier(),
            confidence,
            file: file.to_string(),
            region,
            title: title.to_string(),
            message: message.to_string(),
            anchor,
            introduced: true,
            source: source.to_string(),
            suggestion: None,
            blast_radius: None,
        }
    }

    pub fn with_suggestion(mut self, s: impl Into<String>) -> Finding {
        self.suggestion = Some(s.into());
        self
    }
}

/// Roll-up of a review.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub files_changed: u32,
    pub added_lines: u32,
    pub findings_total: usize,
    pub must_fix: usize,
    pub concern: usize,
    pub nit: usize,
    pub suppressed: usize,
    /// Collectors that ran (and best-effort adapters that were available).
    pub collectors_run: Vec<String>,
    /// Best-effort adapters that were NOT found (honest about coverage gaps).
    pub adapters_absent: Vec<String>,
    /// Degradation notes (circuit breakers tripped, language not deeply analyzed).
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub tool: String,
    pub version: String,
    pub summary: Summary,
    pub findings: Vec<Finding>,
}

/// One added line within a changed file (new-file line number + text).
#[derive(Debug, Clone)]
pub struct AddedLine {
    pub line: u32,
    pub text: String,
}

/// A file touched by the diff, with the clean-as-you-code added-line set.
#[derive(Debug, Clone, Default)]
pub struct ChangedFile {
    pub path: String,
    pub added: Vec<AddedLine>,
    pub added_set: BTreeSet<u32>,
    pub removed_count: u32,
    pub is_new: bool,
    pub is_deleted: bool,
}

impl ChangedFile {
    pub fn is_in_added_set(&self, line: u32) -> bool {
        self.added_set.contains(&line)
    }
}
