//! Mutation-report adapter — diff-scoped "no test failed when this line's
//! behavior changed" facts. Like the coverage adapter, this never executes
//! anything: it reads the artifact a mutation-testing run already produced
//! (Stryker `mutation.json`, cargo-mutants `missed.txt`) and crosses surviving
//! mutants with the added-line set. A surviving mutant on an added line is the
//! strongest test-adequacy fact a reviewer can cite: the behavior was changed
//! and the suite stayed green. Reports older than the file's last edit are
//! skipped (same staleness rule as coverage).

use super::{Collector, ReviewContext};
use crate::model::{Anchor, AnchorKind, Category, Finding, Region, Severity};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Stryker JSON report locations (mutation-testing-report-schema).
const STRYKER_CANDIDATES: &[&str] =
    &["reports/mutation/mutation.json", "reports/mutation.json", "mutation.json"];
/// cargo-mutants writes one missed mutant per line here.
const CARGO_MUTANTS_MISSED: &str = "mutants.out/missed.txt";

/// At most this many mutant findings per file; the last one says how many more.
const PER_FILE_CAP: usize = 5;

#[derive(Debug, Clone, PartialEq)]
struct Mutant {
    file: String,
    line: u32,
    /// Human description, e.g. "ArithmeticOperator: replaced + with -".
    desc: String,
    /// True when the mutant was never executed by any test (Stryker NoCoverage).
    no_coverage: bool,
}

pub struct FoundReport {
    pub path: PathBuf,
    pub label: String,
}

/// Locate mutation reports for this repo (both kinds may coexist).
pub fn find_reports(root: &Path) -> Vec<FoundReport> {
    let mut out = Vec::new();
    if let Some(c) = STRYKER_CANDIDATES.iter().find(|c| root.join(c).is_file()) {
        out.push(FoundReport { path: root.join(c), label: (*c).to_string() });
    }
    if root.join(CARGO_MUTANTS_MISSED).is_file() {
        out.push(FoundReport {
            path: root.join(CARGO_MUTANTS_MISSED),
            label: CARGO_MUTANTS_MISSED.to_string(),
        });
    }
    out
}

pub struct Mutation;

impl Collector for Mutation {
    fn name(&self) -> &'static str {
        "mutation"
    }

    fn run(&self, ctx: &ReviewContext) -> Vec<Finding> {
        let mut out = Vec::new();
        for report in find_reports(&ctx.root) {
            let Ok(text) = fs::read_to_string(&report.path) else {
                continue;
            };
            let mutants = if report.label.ends_with(".json") {
                parse_stryker(&text)
            } else {
                parse_missed_txt(&text)
            };
            if mutants.is_empty() {
                continue;
            }
            // Group surviving mutants per report-native path once.
            let mut by_file: HashMap<&str, Vec<&Mutant>> = HashMap::new();
            for m in &mutants {
                by_file.entry(m.file.as_str()).or_default().push(m);
            }
            let report_mtime = mtime(&report.path);

            for file in ctx.reviewable_files() {
                if file.added.is_empty() {
                    continue;
                }
                if let (Some(rm), Some(fm)) = (report_mtime, mtime(&ctx.root.join(&file.path))) {
                    if fm > rm {
                        continue; // report predates the edit — lines don't line up
                    }
                }
                let Some(file_mutants) = lookup(&by_file, &file.path) else {
                    continue;
                };
                let mut hits: Vec<&&Mutant> = file_mutants
                    .iter()
                    .filter(|m| file.is_in_added_set(m.line))
                    .collect();
                hits.sort_by_key(|m| m.line);
                let total = hits.len();
                for (i, m) in hits.iter().take(PER_FILE_CAP).enumerate() {
                    let overflow = if i == PER_FILE_CAP - 1 && total > PER_FILE_CAP {
                        format!(" (+{} more surviving mutants in this file — see {})",
                            total - PER_FILE_CAP, report.label)
                    } else {
                        String::new()
                    };
                    let (rule, severity, title, claim) = if m.no_coverage {
                        (
                            "tests.mutant-no-coverage",
                            Severity::Low,
                            "Mutant on added line never executed by tests",
                            "no test executed this mutant at all",
                        )
                    } else {
                        (
                            "tests.surviving-mutant",
                            Severity::Medium,
                            "Surviving mutant on added line",
                            "the test suite stayed green with the behavior changed",
                        )
                    };
                    let msg = format!(
                        "Mutation testing altered this added line ({}) and {} — \
                         the new logic is unconstrained by the tests ({}).{overflow}",
                        m.desc, claim, report.label,
                    );
                    out.push(Finding::new(
                        rule,
                        Category::Maintainability,
                        severity,
                        &file.path,
                        Region::line(m.line),
                        title,
                        &msg,
                        Anchor {
                            kind: AnchorKind::Metric,
                            detail: format!("{}: {} @ line {}", report.label, m.desc, m.line),
                        },
                        0.85,
                        "mutation",
                        &format!("{}:{}:{}", file.path, m.line, m.desc),
                    ));
                }
            }
        }
        out
    }
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).ok()?.modified().ok()
}

fn norm(p: &str) -> String {
    p.trim().replace('\\', "/")
}

/// Exact path match, then suffix match at a `/` boundary in either direction.
fn lookup<'a>(
    by_file: &'a HashMap<&str, Vec<&'a Mutant>>,
    changed: &str,
) -> Option<&'a Vec<&'a Mutant>> {
    if let Some(v) = by_file.get(changed) {
        return Some(v);
    }
    let needle = format!("/{changed}");
    by_file
        .iter()
        .find(|(k, _)| k.ends_with(&needle) || changed.ends_with(&format!("/{k}")))
        .map(|(_, v)| v)
}

/// Stryker mutation-testing-report-schema JSON: `files.<path>.mutants[]` with
/// `status`, `mutatorName`, `replacement`, `location.start.line` (1-based).
/// Only `Survived` and `NoCoverage` mutants matter to a reviewer.
fn parse_stryker(text: &str) -> Vec<Mutant> {
    let mut out = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return out;
    };
    let Some(files) = v.get("files").and_then(|f| f.as_object()) else {
        return out;
    };
    for (path, entry) in files {
        let Some(mutants) = entry.get("mutants").and_then(|m| m.as_array()) else {
            continue;
        };
        for m in mutants {
            let status = m.get("status").and_then(|s| s.as_str()).unwrap_or("");
            if status != "Survived" && status != "NoCoverage" {
                continue;
            }
            let Some(line) = m
                .get("location")
                .and_then(|l| l.get("start"))
                .and_then(|s| s.get("line"))
                .and_then(|l| l.as_u64())
            else {
                continue;
            };
            let mutator = m.get("mutatorName").and_then(|s| s.as_str()).unwrap_or("mutant");
            let desc = match m.get("replacement").and_then(|s| s.as_str()) {
                Some(r) if !r.is_empty() => {
                    format!("{mutator}: replaced with `{}`", truncate(r, 40))
                }
                _ => mutator.to_string(),
            };
            out.push(Mutant {
                file: norm(path),
                line: line as u32,
                desc,
                no_coverage: status == "NoCoverage",
            });
        }
    }
    out
}

/// cargo-mutants `mutants.out/missed.txt`: one missed mutant per line,
/// `<path>:<line>[:<col>]: <description>`.
fn parse_missed_txt(text: &str) -> Vec<Mutant> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let mut parts = raw.splitn(4, ':');
        let (Some(file), Some(line)) = (parts.next(), parts.next()) else {
            continue;
        };
        let Ok(line) = line.trim().parse::<u32>() else {
            continue;
        };
        let rest = parts.next().unwrap_or("");
        let tail = parts.next().unwrap_or("");
        // Third segment is a column number in newer cargo-mutants output.
        let desc = if rest.trim().parse::<u32>().is_ok() { tail } else { rest };
        let desc = desc.trim();
        out.push(Mutant {
            file: norm(file),
            line,
            desc: if desc.is_empty() { "mutant missed".to_string() } else { desc.to_string() },
            no_coverage: false,
        });
    }
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::DiffMode;
    use crate::model::{AddedLine, ChangedFile};
    use std::collections::BTreeSet;

    fn changed(path: &str, lines: &[u32]) -> ChangedFile {
        ChangedFile {
            path: path.to_string(),
            added: lines.iter().map(|l| AddedLine { line: *l, text: String::new() }).collect(),
            added_set: lines.iter().copied().collect::<BTreeSet<u32>>(),
            removed_count: 0,
            is_new: false,
            is_deleted: false,
        }
    }

    #[test]
    fn parses_stryker_survived_and_no_coverage() {
        let json = r#"{ "schemaVersion": "1", "files": { "src/a.ts": { "mutants": [
            { "status": "Survived", "mutatorName": "ArithmeticOperator", "replacement": "-",
              "location": { "start": { "line": 5, "column": 3 }, "end": { "line": 5, "column": 4 } } },
            { "status": "Killed", "mutatorName": "BooleanLiteral",
              "location": { "start": { "line": 9, "column": 1 }, "end": { "line": 9, "column": 2 } } },
            { "status": "NoCoverage", "mutatorName": "StringLiteral",
              "location": { "start": { "line": 12, "column": 1 }, "end": { "line": 12, "column": 2 } } }
        ] } } }"#;
        let m = parse_stryker(json);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].line, 5);
        assert!(!m[0].no_coverage);
        assert!(m[1].no_coverage);
    }

    #[test]
    fn parses_cargo_mutants_missed_txt() {
        let txt = "src/lib.rs:102:9: replace divide -> f64 with 0.0\nsrc/lib.rs:7: replace add with ()\n";
        let m = parse_missed_txt(txt);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0], Mutant {
            file: "src/lib.rs".into(),
            line: 102,
            desc: "replace divide -> f64 with 0.0".into(),
            no_coverage: false,
        });
        assert_eq!(m[1].line, 7);
        assert_eq!(m[1].desc, "replace add with ()");
    }

    #[test]
    fn flags_surviving_mutant_on_added_line_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "x\n".repeat(20)).unwrap();
        std::fs::create_dir_all(root.join("mutants.out")).unwrap();
        std::fs::write(
            root.join("mutants.out/missed.txt"),
            "src/lib.rs:5:1: replace foo with true\nsrc/lib.rs:15:1: replace bar with 0\n",
        )
        .unwrap();

        let ctx = ReviewContext {
            root: root.to_path_buf(),
            mode: DiffMode::Working,
            files: vec![changed("src/lib.rs", &[4, 5, 6])], // line 15 not added
            scip: None,
        };
        let f = Mutation.run(&ctx);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].rule_id, "tests.surviving-mutant");
        assert_eq!(f[0].region.start_line, 5);
    }
}
