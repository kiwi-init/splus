//! Coverage adapter — diff-scoped test-coverage facts from a report already on
//! disk. Zero inference and zero execution: we never run the test suite, we read
//! the artifact it produced (lcov / Cobertura XML / Istanbul JSON / Go
//! coverprofile) and cross it with the added-line set. The claim is narrow and
//! refutable: "the coverage report instruments this added line and records zero
//! hits". A report older than the file's last edit cannot make that claim, so
//! stale files are skipped entirely (precision over recall).

use super::{Collector, ReviewContext};
use crate::model::{Anchor, AnchorKind, Category, Finding, Region, Severity};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Well-known report locations, checked in order (first hit wins).
/// `SPLUS_COVERAGE_FILE` overrides discovery entirely.
const CANDIDATES: &[&str] = &[
    "lcov.info",
    "coverage/lcov.info",
    "coverage/lcov/lcov.info",
    "coverage/coverage-final.json",
    "coverage/cobertura-coverage.xml",
    "coverage/coverage.xml",
    "coverage.xml",
    "cobertura.xml",
    "coverage.out",
    "cover.out",
];

/// Uncovered-added-line count at/above which the finding is a `concern`.
const MEDIUM_THRESHOLD: usize = 8;

/// Instrumented line → hit count, per report-native file path.
type CoverageData = BTreeMap<String, BTreeMap<u32, u64>>;

pub struct FoundReport {
    pub path: PathBuf,
    /// Repo-relative label used in messages/anchors (or the env override verbatim).
    pub label: String,
}

/// Locate a coverage report for this repo, if any.
pub fn find_report(root: &Path) -> Option<FoundReport> {
    if let Ok(p) = std::env::var("SPLUS_COVERAGE_FILE") {
        let abs = if Path::new(&p).is_absolute() { PathBuf::from(&p) } else { root.join(&p) };
        return abs.exists().then(|| FoundReport { path: abs, label: p });
    }
    CANDIDATES.iter().find_map(|c| {
        let p = root.join(c);
        p.is_file().then(|| FoundReport { path: p, label: (*c).to_string() })
    })
}

pub struct Coverage;

impl Collector for Coverage {
    fn name(&self) -> &'static str {
        "coverage"
    }

    fn run(&self, ctx: &ReviewContext) -> Vec<Finding> {
        let Some(found) = find_report(&ctx.root) else {
            return Vec::new();
        };
        let Ok(text) = fs::read_to_string(&found.path) else {
            return Vec::new();
        };
        let data = normalize_keys(parse_report(&found.path, &text), &ctx.root);
        if data.is_empty() {
            return Vec::new();
        }
        let report_mtime = mtime(&found.path);

        let mut out = Vec::new();
        for file in ctx.reviewable_files() {
            if file.added.is_empty() {
                continue;
            }
            // Staleness guard: a report produced before the file's last edit is
            // talking about different line numbers — never flag from it.
            if let (Some(rm), Some(fm)) = (report_mtime, mtime(&ctx.root.join(&file.path))) {
                if fm > rm {
                    continue;
                }
            }
            let Some(lines) = lines_for(&data, &file.path) else {
                continue;
            };
            let uncovered: Vec<u32> = file
                .added
                .iter()
                .map(|a| a.line)
                .filter(|l| lines.get(l).is_some_and(|h| *h == 0))
                .collect();
            if uncovered.is_empty() {
                continue;
            }
            let instrumented = file.added.iter().filter(|a| lines.contains_key(&a.line)).count();
            let ranges = to_ranges(&uncovered);
            let severity = if uncovered.len() >= MEDIUM_THRESHOLD {
                Severity::Medium
            } else {
                Severity::Low
            };
            let msg = format!(
                "{}/{} instrumented added line(s) have zero test coverage (line {}). \
                 The coverage report ({}) was produced after this file's last edit and \
                 never executed these lines — the new behavior is untested.",
                uncovered.len(),
                instrumented,
                fmt_ranges(&ranges),
                found.label,
            );
            out.push(Finding::new(
                "tests.uncovered-added-lines",
                Category::Maintainability,
                severity,
                &file.path,
                Region {
                    start_line: ranges[0].0,
                    start_col: 0,
                    end_line: ranges[0].1,
                    end_col: 0,
                },
                "Untested added lines",
                &msg,
                Anchor {
                    kind: AnchorKind::Metric,
                    detail: format!(
                        "{}: {}/{} instrumented added lines uncovered",
                        found.label,
                        uncovered.len(),
                        instrumented
                    ),
                },
                0.9,
                "coverage",
                // Fingerprint per file (stable across line shifts / re-runs).
                &format!("{}::uncovered-added", file.path),
            ));
        }
        out
    }
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).ok()?.modified().ok()
}

/// Dispatch on file extension; unknown formats parse to empty (never error).
fn parse_report(path: &Path, text: &str) -> CoverageData {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "info" => parse_lcov(text),
        "json" => parse_istanbul(text),
        "xml" => parse_cobertura(text),
        "out" => parse_go(text),
        _ => CoverageData::new(),
    }
}

fn norm(p: &str) -> String {
    p.trim().replace('\\', "/")
}

/// Strip the repo root off absolute report paths so they line up with the
/// repo-relative changed-file paths.
fn normalize_keys(data: CoverageData, root: &Path) -> CoverageData {
    let root_str = format!("{}/", norm(&root.to_string_lossy()).trim_end_matches('/'));
    data.into_iter()
        .map(|(k, v)| {
            let k = k.strip_prefix(&root_str).map(str::to_string).unwrap_or(k);
            (k, v)
        })
        .collect()
}

/// Resolve coverage lines for a changed file: exact path match first, then a
/// suffix match at a `/` boundary in either direction (handles Go module paths
/// and reports rooted somewhere other than the repo root).
fn lines_for<'a>(data: &'a CoverageData, changed: &str) -> Option<&'a BTreeMap<u32, u64>> {
    if let Some(v) = data.get(changed) {
        return Some(v);
    }
    let needle = format!("/{changed}");
    data.iter()
        .find(|(k, _)| k.ends_with(&needle) || changed.ends_with(&format!("/{k}")))
        .map(|(_, v)| v)
}

/// Group sorted line numbers into contiguous (start, end) ranges.
fn to_ranges(lines: &[u32]) -> Vec<(u32, u32)> {
    let mut sorted = lines.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut out: Vec<(u32, u32)> = Vec::new();
    for l in sorted {
        match out.last_mut() {
            Some((_, end)) if *end + 1 == l => *end = l,
            _ => out.push((l, l)),
        }
    }
    out
}

fn fmt_ranges(ranges: &[(u32, u32)]) -> String {
    const SHOWN: usize = 6;
    let mut parts: Vec<String> = ranges
        .iter()
        .take(SHOWN)
        .map(|(s, e)| if s == e { s.to_string() } else { format!("{s}–{e}") })
        .collect();
    if ranges.len() > SHOWN {
        parts.push(format!("+{} more", ranges.len() - SHOWN));
    }
    parts.join(", ")
}

// --- format parsers (pure, tested on canned inputs) ---

/// lcov tracefile: `SF:<path>` opens a record, `DA:<line>,<hits>` instruments a
/// line, `end_of_record` closes. Merged reports keep the max hit count.
fn parse_lcov(text: &str) -> CoverageData {
    let mut map = CoverageData::new();
    let mut cur: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(p) = line.strip_prefix("SF:") {
            cur = Some(norm(p));
        } else if line == "end_of_record" {
            cur = None;
        } else if let (Some(f), Some(rest)) = (&cur, line.strip_prefix("DA:")) {
            let mut it = rest.split(',');
            if let (Some(l), Some(h)) = (it.next(), it.next()) {
                if let (Ok(l), Ok(h)) = (l.trim().parse::<u32>(), h.trim().parse::<u64>()) {
                    let e = map.entry(f.clone()).or_default().entry(l).or_insert(0);
                    *e = (*e).max(h);
                }
            }
        }
    }
    map
}

/// Istanbul `coverage-final.json`: per-file `statementMap` (statement id →
/// location) + `s` (statement id → hit count). A line is covered if any
/// statement starting on it was hit.
fn parse_istanbul(text: &str) -> CoverageData {
    let mut map = CoverageData::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return map;
    };
    let Some(obj) = v.as_object() else {
        return map;
    };
    for (path, entry) in obj {
        let (Some(sm), Some(s)) = (
            entry.get("statementMap").and_then(|x| x.as_object()),
            entry.get("s").and_then(|x| x.as_object()),
        ) else {
            continue;
        };
        let lines = map.entry(norm(path)).or_default();
        for (id, loc) in sm {
            let Some(line) = loc
                .get("start")
                .and_then(|st| st.get("line"))
                .and_then(|l| l.as_u64())
            else {
                continue;
            };
            let hits = s.get(id).and_then(|h| h.as_u64()).unwrap_or(0);
            let e = lines.entry(line as u32).or_insert(0);
            *e = (*e).max(hits);
        }
    }
    map
}

/// Cobertura XML: `<class filename="...">` scopes `<line number="..." hits="..."/>`
/// elements. Tokenized on `<` — tolerant of formatting, no XML dependency.
fn parse_cobertura(text: &str) -> CoverageData {
    let mut map = CoverageData::new();
    let mut cur: Option<String> = None;
    for tag in text.split('<') {
        if tag.starts_with("class ") || tag.starts_with("class\t") {
            cur = attr(tag, "filename").map(|f| norm(&f));
        } else if tag.starts_with("line ") {
            if let Some(f) = &cur {
                if let (Some(n), Some(h)) = (attr(tag, "number"), attr(tag, "hits")) {
                    if let (Ok(n), Ok(h)) = (n.parse::<u32>(), h.parse::<u64>()) {
                        let e = map.entry(f.clone()).or_default().entry(n).or_insert(0);
                        *e = (*e).max(h);
                    }
                }
            }
        }
    }
    map
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let pat = format!("{name}=\"");
    let i = tag.find(&pat)? + pat.len();
    let rest = &tag[i..];
    Some(rest[..rest.find('"')?].to_string())
}

/// Go coverprofile: `<file>:<sl>.<sc>,<el>.<ec> <numStmts> <count>` per block.
fn parse_go(text: &str) -> CoverageData {
    let mut map = CoverageData::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("mode:") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(loc), Some(_stmts), Some(count)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(count) = count.parse::<u64>() else {
            continue;
        };
        let Some((file, range)) = loc.rsplit_once(':') else {
            continue;
        };
        let Some((start, end)) = range.split_once(',') else {
            continue;
        };
        let (Some(sl), Some(el)) = (
            start.split('.').next().and_then(|s| s.parse::<u32>().ok()),
            end.split('.').next().and_then(|s| s.parse::<u32>().ok()),
        ) else {
            continue;
        };
        let lines = map.entry(norm(file)).or_default();
        for l in sl..=el.max(sl) {
            let e = lines.entry(l).or_insert(0);
            *e = (*e).max(count);
        }
    }
    map
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
    fn parses_lcov() {
        let data = parse_lcov("TN:\nSF:src/a.ts\nDA:1,3\nDA:2,0\nDA:5,0\nend_of_record\n");
        let lines = data.get("src/a.ts").unwrap();
        assert_eq!(lines.get(&1), Some(&3));
        assert_eq!(lines.get(&2), Some(&0));
        assert_eq!(lines.get(&5), Some(&0));
    }

    #[test]
    fn parses_istanbul() {
        let json = r#"{ "src/a.ts": { "statementMap": { "0": { "start": { "line": 4, "column": 0 }, "end": { "line": 4, "column": 10 } } }, "s": { "0": 0 } } }"#;
        let data = parse_istanbul(json);
        assert_eq!(data.get("src/a.ts").unwrap().get(&4), Some(&0));
    }

    #[test]
    fn parses_cobertura() {
        let xml = r#"<coverage><packages><package><classes>
            <class name="A" filename="src/a.py"><lines>
              <line number="3" hits="0"/><line number="4" hits="2"/>
            </lines></class>
        </classes></package></packages></coverage>"#;
        let data = parse_cobertura(xml);
        let lines = data.get("src/a.py").unwrap();
        assert_eq!(lines.get(&3), Some(&0));
        assert_eq!(lines.get(&4), Some(&2));
    }

    #[test]
    fn parses_go_coverprofile() {
        let prof = "mode: set\ngithub.com/x/pkg/a.go:10.2,12.16 2 0\ngithub.com/x/pkg/a.go:14.2,14.20 1 1\n";
        let data = parse_go(prof);
        let lines = data.get("github.com/x/pkg/a.go").unwrap();
        assert_eq!(lines.get(&10), Some(&0));
        assert_eq!(lines.get(&11), Some(&0));
        assert_eq!(lines.get(&14), Some(&1));
    }

    #[test]
    fn suffix_match_resolves_module_paths() {
        let data = parse_go("mode: set\ngithub.com/x/pkg/a.go:10.1,10.5 1 0\n");
        assert!(lines_for(&data, "pkg/a.go").is_some());
        assert!(lines_for(&data, "pkg/b.go").is_none());
    }

    #[test]
    fn ranges_group_and_format() {
        assert_eq!(to_ranges(&[5, 3, 4, 9]), vec![(3, 5), (9, 9)]);
        assert_eq!(fmt_ranges(&[(3, 5), (9, 9)]), "3–5, 9");
    }

    #[test]
    fn flags_uncovered_added_lines_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.ts"), "l1\nl2\nl3\nl4\nl5\n").unwrap();
        // Report written after the source file → not stale.
        std::fs::write(root.join("lcov.info"), "SF:src/a.ts\nDA:2,0\nDA:3,0\nDA:4,7\nend_of_record\n").unwrap();

        let ctx = ReviewContext {
            root: root.to_path_buf(),
            mode: DiffMode::Working,
            files: vec![changed("src/a.ts", &[2, 3, 4])],
            scip: None,
        };
        let f = Coverage.run(&ctx);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].rule_id, "tests.uncovered-added-lines");
        assert!(f[0].message.contains("2/3"), "message: {}", f[0].message);
        assert_eq!(f[0].region.start_line, 2);
        assert_eq!(f[0].region.end_line, 3);
    }

    #[test]
    fn silent_without_report_or_coverage_rows() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ReviewContext {
            root: dir.path().to_path_buf(),
            mode: DiffMode::Working,
            files: vec![changed("src/a.ts", &[2])],
            scip: None,
        };
        assert!(Coverage.run(&ctx).is_empty());
    }
}
