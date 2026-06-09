//! History collector — deterministic risk facts mined from `git log`. Two
//! signals a senior reviewer checks by instinct, surfaced as grounded facts:
//!
//! - **fix-churn**: this changed file keeps appearing in bug-fix commits — its
//!   changes have a history of going wrong, so review with extra care.
//! - **co-change-missing**: a file that almost always changes together with a
//!   changed file is absent from this diff — a "did you forget X?" prompt.
//!
//! One `git log --name-only` walk over a bounded window (12 months, 1000
//! commits, no merges) feeds both. Skipped in `--all` mode, where "the diff" is
//! the whole repo and neither signal is meaningful. Output is capped per signal
//! so a churn-heavy repo can't flood the floor.

use super::{is_generated, Collector, ReviewContext};
use crate::diff::{self, DiffMode};
use crate::model::{Anchor, AnchorKind, Category, Finding, Region, Severity};
use std::collections::{HashMap, HashSet};

/// Bug-fix commits touching a file before it's worth flagging.
const CHURN_MIN: usize = 3;
/// Fix-churn at/above this escalates Info → Low.
const CHURN_HIGH: usize = 6;
/// Minimum commits touching a file before co-change rates mean anything.
const COCHANGE_MIN_COMMITS: usize = 5;
/// Minimum times the partner must have co-changed.
const COCHANGE_MIN_PAIR: usize = 4;
/// Minimum co-change rate (pair / file commits).
const COCHANGE_MIN_RATE: f32 = 0.6;
/// Commits touching more than this many files are mass refactors / formatting
/// sweeps — they poison co-change statistics and are excluded from them.
const COCHANGE_MAX_COMMIT_FILES: usize = 30;
/// Per-signal output caps (highest-evidence findings win).
const MAX_PER_SIGNAL: usize = 8;

pub struct History;

impl Collector for History {
    fn name(&self) -> &'static str {
        "history"
    }

    fn run(&self, ctx: &ReviewContext) -> Vec<Finding> {
        // In --all mode every file is "changed": churn would flag half the repo
        // and a co-change partner can never be missing.
        if matches!(ctx.mode, DiffMode::All) {
            return Vec::new();
        }
        let Ok(log) = diff::git(
            &ctx.root,
            &[
                "log",
                "--since=12.months",
                "--max-count=1000",
                "--no-merges",
                "--no-renames",
                "--diff-filter=ACMR",
                "--name-only",
                "--pretty=format:%x01%s",
            ],
        ) else {
            return Vec::new();
        };
        let commits = parse_git_log(&log);
        let changed: Vec<(String, u32)> = ctx
            .reviewable_files()
            .filter(|f| !f.added.is_empty())
            .map(|f| (f.path.clone(), f.added.first().map(|a| a.line).unwrap_or(1)))
            .collect();
        let mut out = analyze(&commits, &changed);
        // Only "did you forget X?" about files that still exist.
        out.retain(|f| {
            f.rule_id != "history.co-change-missing"
                || partner_of(f).map(|p| ctx.root.join(p).is_file()).unwrap_or(false)
        });
        out
    }
}

/// The co-change partner is recorded in the anchor detail as `partner=<path>`.
fn partner_of(f: &Finding) -> Option<&str> {
    f.anchor.detail.split("partner=").nth(1)
}

#[derive(Debug, PartialEq)]
pub struct ParsedCommit {
    pub subject: String,
    pub files: Vec<String>,
}

/// Parse `git log --name-only --pretty=format:%x01%s` output: each commit is a
/// `\x01`-prefixed subject line followed by its file paths.
fn parse_git_log(out: &str) -> Vec<ParsedCommit> {
    out.split('\u{1}')
        .filter(|c| !c.trim().is_empty())
        .map(|chunk| {
            let mut lines = chunk.lines();
            let subject = lines.next().unwrap_or("").trim().to_string();
            let files = lines
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect();
            ParsedCommit { subject, files }
        })
        .collect()
}

fn is_fixish(subject: &str) -> bool {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\b(fix(es|ed)?|bug|bugfix|hotfix|regression|revert(s|ed)?)\b")
            .expect("static regex")
    })
    .is_match(subject)
}

/// Pure analysis over parsed commits; `changed` is (path, first added line).
fn analyze(commits: &[ParsedCommit], changed: &[(String, u32)]) -> Vec<Finding> {
    let changed_set: HashSet<&str> = changed.iter().map(|(p, _)| p.as_str()).collect();

    // Per changed file: (commits touching it, fix commits touching it) — and,
    // over statistics-worthy commits only, co-change partner counts.
    let mut touch: HashMap<&str, (usize, usize)> = HashMap::new();
    let mut stat_touch: HashMap<&str, usize> = HashMap::new();
    let mut pair: HashMap<(&str, String), usize> = HashMap::new();

    for c in commits {
        let fixish = is_fixish(&c.subject);
        let in_diff: Vec<&str> = c
            .files
            .iter()
            .map(String::as_str)
            .filter(|f| changed_set.contains(f))
            .collect();
        for &f in &in_diff {
            let e = touch.entry(f).or_insert((0, 0));
            e.0 += 1;
            if fixish {
                e.1 += 1;
            }
        }
        if c.files.len() > COCHANGE_MAX_COMMIT_FILES {
            continue;
        }
        for &f in &in_diff {
            *stat_touch.entry(f).or_insert(0) += 1;
            for p in &c.files {
                if p != f && !changed_set.contains(p.as_str()) && !is_generated(p) {
                    *pair.entry((f, p.clone())).or_insert(0) += 1;
                }
            }
        }
    }

    let mut churn: Vec<Finding> = Vec::new();
    let mut cochange: Vec<Finding> = Vec::new();

    for (path, first_line) in changed {
        let (n_total, n_fix) = touch.get(path.as_str()).copied().unwrap_or((0, 0));
        if n_fix >= CHURN_MIN {
            let severity = if n_fix >= CHURN_HIGH { Severity::Low } else { Severity::Info };
            let msg = format!(
                "{n_fix} of the {n_total} commits touching this file in the last 12 months \
                 were bug-fixes — changes here have a history of going wrong. Worth a \
                 closer look at edge cases and tests. (Risk signal, not a defect.)"
            );
            churn.push(Finding::new(
                "history.fix-churn",
                Category::Impact,
                severity,
                path,
                Region::line(*first_line),
                "Bug-prone file",
                &msg,
                Anchor {
                    kind: AnchorKind::Heuristic,
                    detail: format!("git log: {n_fix}/{n_total} fix-commits in 12 months"),
                },
                0.6,
                "history",
                &format!("{path}::fix-churn"),
            ));
        }

        let n_stat = stat_touch.get(path.as_str()).copied().unwrap_or(0);
        if n_stat >= COCHANGE_MIN_COMMITS {
            let best = pair
                .iter()
                .filter(|((f, _), _)| *f == path.as_str())
                .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0 .1.cmp(&a.0 .1)));
            if let Some(((_, partner), &count)) = best {
                let rate = count as f32 / n_stat as f32;
                if count >= COCHANGE_MIN_PAIR && rate >= COCHANGE_MIN_RATE {
                    let msg = format!(
                        "`{partner}` changed together with this file in {count} of its last \
                         {n_stat} commits ({:.0}%) but isn't touched by this change — check \
                         whether it needs a matching update.",
                        rate * 100.0
                    );
                    cochange.push(Finding::new(
                        "history.co-change-missing",
                        Category::Impact,
                        Severity::Low,
                        path,
                        Region::line(*first_line),
                        "Frequently co-changed file not in this diff",
                        &msg,
                        Anchor {
                            kind: AnchorKind::Heuristic,
                            detail: format!(
                                "git log: co-changed {count}/{n_stat} commits; partner={partner}"
                            ),
                        },
                        0.55,
                        "history",
                        &format!("{path}::co-change::{partner}"),
                    ));
                }
            }
        }
    }

    // Highest-evidence first, then cap so churn-heavy repos can't flood the floor.
    churn.sort_by(|a, b| {
        b.severity.rank().cmp(&a.severity.rank()).then_with(|| a.file.cmp(&b.file))
    });
    churn.truncate(MAX_PER_SIGNAL);
    cochange.truncate(MAX_PER_SIGNAL);
    churn.extend(cochange);
    churn
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(subject: &str, files: &[&str]) -> ParsedCommit {
        ParsedCommit {
            subject: subject.to_string(),
            files: files.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn parses_log_output() {
        let raw = "\u{1}fix: crash on empty input\nsrc/a.ts\nsrc/b.ts\n\n\u{1}feat: add thing\nsrc/c.ts\n";
        let commits = parse_git_log(raw);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "fix: crash on empty input");
        assert_eq!(commits[0].files, vec!["src/a.ts", "src/b.ts"]);
        assert_eq!(commits[1].files, vec!["src/c.ts"]);
    }

    #[test]
    fn fixish_subjects() {
        assert!(is_fixish("fix: null deref"));
        assert!(is_fixish("Fixed flaky retry"));
        assert!(is_fixish("Revert \"add cache\""));
        assert!(is_fixish("hotfix for prod"));
        assert!(!is_fixish("feat: add suffix matching"));
        assert!(!is_fixish("prefix the logger"));
    }

    #[test]
    fn flags_fix_churn_at_threshold() {
        let commits = vec![
            commit("fix: a", &["src/a.ts"]),
            commit("bug: b", &["src/a.ts"]),
            commit("fix: c", &["src/a.ts"]),
            commit("feat: d", &["src/a.ts"]),
            commit("fix: unrelated", &["src/z.ts"]),
        ];
        let f = analyze(&commits, &[("src/a.ts".into(), 10)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].rule_id, "history.fix-churn");
        assert!(f[0].message.contains("3 of the 4"), "msg: {}", f[0].message);
        assert_eq!(f[0].region.start_line, 10);

        // Below threshold → silent.
        let quiet = analyze(&commits[..2], &[("src/a.ts".into(), 10)]);
        assert!(quiet.is_empty());
    }

    #[test]
    fn flags_missing_co_change_partner() {
        // src/a.ts and src/a.test.ts co-change in 5/6 commits; diff touches only a.ts.
        let mut commits: Vec<ParsedCommit> = (0..5)
            .map(|i| commit(&format!("feat: {i}"), &["src/a.ts", "src/a.test.ts"]))
            .collect();
        commits.push(commit("feat: solo", &["src/a.ts"]));
        let f = analyze(&commits, &[("src/a.ts".into(), 3)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].rule_id, "history.co-change-missing");
        assert!(f[0].message.contains("src/a.test.ts"));
        assert!(f[0].anchor.detail.contains("partner=src/a.test.ts"));
    }

    #[test]
    fn partner_in_diff_or_mass_commits_do_not_fire() {
        // Partner included in the diff → no finding.
        let commits: Vec<ParsedCommit> = (0..6)
            .map(|i| commit(&format!("feat: {i}"), &["src/a.ts", "src/a.test.ts"]))
            .collect();
        let f = analyze(
            &commits,
            &[("src/a.ts".into(), 1), ("src/a.test.ts".into(), 1)],
        );
        assert!(f.iter().all(|x| x.rule_id != "history.co-change-missing"));

        // Mass commits are excluded from co-change statistics.
        let big: Vec<String> = (0..40).map(|i| format!("src/f{i}.ts")).collect();
        let mut big_files: Vec<&str> = big.iter().map(String::as_str).collect();
        big_files.push("src/a.ts");
        let mass: Vec<ParsedCommit> =
            (0..6).map(|i| commit(&format!("chore: {i}"), &big_files)).collect();
        assert!(analyze(&mass, &[("src/a.ts".into(), 1)]).is_empty());
    }
}
