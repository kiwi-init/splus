//! Output renderers: a precision-first terminal view, machine JSON, and SARIF.

use crate::model::{Category, Finding, Report, Severity, Tier};
use serde_json::json;

#[derive(Clone, Copy)]
pub struct Theme {
    pub color: bool,
}

impl Theme {
    fn paint(&self, code: &str, s: &str) -> String {
        if self.color {
            format!("\x1b[{code}m{s}\x1b[0m")
        } else {
            s.to_string()
        }
    }
    fn dim(&self, s: &str) -> String {
        self.paint("2", s)
    }
    fn bold(&self, s: &str) -> String {
        self.paint("1", s)
    }
}

fn sev_dot(sev: Severity, t: &Theme) -> String {
    let (code, label) = match sev {
        Severity::Critical => ("31;1", "●"),
        Severity::High => ("31", "●"),
        Severity::Medium => ("33", "●"),
        Severity::Low => ("36", "○"),
        Severity::Info => ("2", "○"),
    };
    t.paint(code, label)
}

fn cat_tag(c: Category) -> &'static str {
    match c {
        Category::Security => "security",
        Category::Supplychain => "supply-chain",
        Category::Correctness => "correctness",
        Category::Maintainability => "maintainability",
        Category::Hygiene => "hygiene",
        Category::Impact => "impact",
    }
}

/// Human-readable terminal report (default).
pub fn pretty(report: &Report, theme: &Theme) -> String {
    let mut out = String::new();
    let s = &report.summary;

    out.push_str(&theme.bold(&format!("\n  Splus · {}", report.tool)));
    out.push_str(&theme.dim(&format!(" v{}\n", report.version)));
    out.push_str(&theme.dim(&format!(
        "  {} file(s) changed · {} added line(s) · clean-as-you-code\n",
        s.files_changed, s.added_lines
    )));
    out.push_str(&theme.dim(&format!("  {}\n", "─".repeat(60))));

    if report.findings.is_empty() {
        out.push_str(&theme.paint("32", "\n  ✓ No issues on changed lines.\n"));
    } else {
        for tier in [Tier::MustFix, Tier::Concern, Tier::Nit] {
            let group: Vec<&Finding> =
                report.findings.iter().filter(|f| f.tier == tier).collect();
            if group.is_empty() {
                continue;
            }
            let (label, code) = match tier {
                Tier::MustFix => ("must-fix", "31;1"),
                Tier::Concern => ("concern", "33"),
                Tier::Nit => ("nit", "36"),
            };
            out.push_str(&format!("\n  {}\n", theme.bold(&theme.paint(code, label))));
            for f in group {
                out.push_str(&format!(
                    "  {} {}  {}\n",
                    sev_dot(f.severity, theme),
                    theme.bold(&f.title),
                    theme.dim(&format!("[{}:{}]", cat_tag(f.category), f.rule_id))
                ));
                out.push_str(&theme.dim(&format!(
                    "      {}:{}  ·  {:.0}% confidence  ·  {}\n",
                    f.file,
                    f.region.start_line,
                    f.confidence * 100.0,
                    f.anchor.detail
                )));
                for line in wrap(&f.message, 72) {
                    out.push_str(&format!("      {line}\n"));
                }
                if let Some(br) = &f.blast_radius {
                    out.push_str(&theme.paint(
                        "35",
                        &format!(
                            "      ⮑ blast radius: {} direct / {} transitive caller(s) across {} file(s){} · {:.0}% res. confidence ({})\n",
                            br.direct_callers,
                            br.transitive_callers,
                            br.files_affected.len(),
                            if br.crosses_api_boundary { " · crosses API boundary" } else { "" },
                            br.resolution_confidence * 100.0,
                            br.resolution_method
                        ),
                    ));
                }
                if let Some(sug) = &f.suggestion {
                    out.push_str(&theme.paint("32", &format!("      fix: {sug}\n")));
                }
            }
        }
    }

    // Footer.
    out.push_str(&theme.dim(&format!("\n  {}\n", "─".repeat(60))));
    out.push_str(&format!(
        "  {} must-fix · {} concern · {} nit\n",
        theme.paint("31;1", &s.must_fix.to_string()),
        theme.paint("33", &s.concern.to_string()),
        theme.paint("36", &s.nit.to_string()),
    ));
    out.push_str(&theme.dim(&format!(
        "  collectors: {}\n",
        s.collectors_run.join(", ")
    )));
    if !s.adapters_absent.is_empty() {
        out.push_str(&theme.dim(&format!(
            "  adapters not installed (optional): {}\n",
            s.adapters_absent.join(", ")
        )));
    }
    for note in &s.notes {
        out.push_str(&theme.paint("33", &format!("  ⚠ {note}\n")));
    }
    out.push('\n');
    out
}

/// Machine-readable JSON (used by the CLI `--agent` mode and the GitHub App).
pub fn json(report: &Report) -> String {
    serde_json::to_string_pretty(report).unwrap_or_else(|_| "{}".to_string())
}

/// Minimal SARIF 2.1.0 (for GitHub code scanning ingestion).
pub fn sarif(report: &Report) -> String {
    let mut rule_ids: Vec<String> =
        report.findings.iter().map(|f| f.rule_id.clone()).collect();
    rule_ids.sort();
    rule_ids.dedup();
    let rules: Vec<_> = rule_ids
        .iter()
        .map(|id| json!({ "id": id, "name": id }))
        .collect();

    let results: Vec<_> = report
        .findings
        .iter()
        .map(|f| {
            json!({
                "ruleId": f.rule_id,
                "level": sarif_level(f.severity),
                "message": { "text": f.message },
                "partialFingerprints": { "splus/v1": f.id },
                "properties": {
                    "category": cat_tag(f.category),
                    "severity": f.severity,
                    "confidence": f.confidence,
                    "anchor": f.anchor.detail,
                },
                "locations": [{
                    "physicalLocation": {
                        "artifactLocation": { "uri": f.file },
                        "region": {
                            "startLine": f.region.start_line.max(1),
                            "startColumn": f.region.start_col.max(1),
                            "endLine": f.region.end_line.max(f.region.start_line).max(1),
                        }
                    }
                }]
            })
        })
        .collect();

    let doc = json!({
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": { "driver": {
                "name": "Splus",
                "version": report.version,
                "informationUri": "https://github.com/kiwi-init/splus",
                "rules": rules,
            }},
            "results": results,
        }]
    });
    serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".to_string())
}

fn sarif_level(sev: Severity) -> &'static str {
    match sev {
        Severity::Critical | Severity::High => "error",
        Severity::Medium => "warning",
        Severity::Low => "note",
        Severity::Info => "note",
    }
}

/// Naive word wrap for terminal messages.
fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for word in text.split_whitespace() {
        if !cur.is_empty() && cur.len() + 1 + word.len() > width {
            lines.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    lines
}
