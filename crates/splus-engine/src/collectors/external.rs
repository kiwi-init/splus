//! Best-effort adapters for external deterministic tools. Each runs ONLY if the
//! binary is on PATH; the engine is fully functional without any of them. Output
//! is normalized into the canonical Finding model and diff-filtered to added
//! lines. Absent tools are reported honestly in the summary (coverage gaps).
//!
//! License posture (see REPORT.md §8): gitleaks (MIT) is the default secrets
//! adapter; trufflehog (AGPL) is intentionally NOT bundled. Semgrep CE rules
//! must be license-vetted before shipping a curated set.

use super::{Collector, ReviewContext};
use crate::model::{Anchor, AnchorKind, Category, Finding, Region, Severity};
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::tempdir;

/// Optional adapters, in priority order.
pub const ADAPTERS: &[&str] = &["semgrep", "ast-grep", "gitleaks", "osv-scanner"];

/// Is `tool` runnable on PATH? (`.output()` errors only when spawn fails.)
pub fn available(tool: &str) -> bool {
    Command::new(tool).arg("--version").output().is_ok()
}

/// Names of adapters that are NOT installed — surfaced in the summary so we're
/// honest about what we did and didn't check.
pub fn absent() -> Vec<String> {
    ADAPTERS
        .iter()
        .filter(|t| !available(t))
        .map(|t| t.to_string())
        .collect()
}

pub struct External;

impl Collector for External {
    fn name(&self) -> &'static str {
        "external"
    }

    fn run(&self, ctx: &ReviewContext) -> Vec<Finding> {
        let mut out = Vec::new();
        if available("semgrep") {
            out.extend(run_semgrep(ctx));
        }
        if available("ast-grep") {
            out.extend(run_astgrep(ctx));
        }
        if available("gitleaks") {
            out.extend(run_gitleaks(ctx));
        }
        if available("osv-scanner") {
            out.extend(run_osv(ctx));
        }
        out
    }
}

// --- shared helpers --------------------------------------------------------

fn reviewable_abs_paths(ctx: &ReviewContext) -> Vec<String> {
    ctx.reviewable_files()
        .map(|f| ctx.root.join(&f.path).to_string_lossy().into_owned())
        .filter(|p| Path::new(p).exists())
        .collect()
}

/// Map a tool-reported path (absolute or relative) to our repo-relative path.
fn to_rel(ctx: &ReviewContext, path: &str) -> String {
    let p = Path::new(path);
    p.strip_prefix(&ctx.root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

fn added_set<'a>(ctx: &'a ReviewContext, rel: &str) -> Option<&'a BTreeSet<u32>> {
    ctx.files.iter().find(|f| f.path == rel).map(|f| &f.added_set)
}

/// Keep a finding only if it lands on a clean-as-you-code added line.
fn on_added_line(ctx: &ReviewContext, rel: &str, line: u32) -> bool {
    added_set(ctx, rel).map(|s| s.contains(&line)).unwrap_or(false)
}

// --- semgrep (SARIF) -------------------------------------------------------

/// Resolve a **local** semgrep ruleset so we never hit the registry over the
/// network (`--config auto` would — that breaks the 100%-local guarantee).
/// Order: `$SPLUS_SEMGREP_CONFIG`, then `~/.splus/semgrep/` (written by the
/// installer). Returns None when no offline ruleset is present → skip semgrep.
fn semgrep_config() -> Option<String> {
    if let Some(c) = std::env::var_os("SPLUS_SEMGREP_CONFIG") {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    let home = std::env::var_os("HOME")?;
    let dir = PathBuf::from(home).join(".splus").join("semgrep");
    if dir.is_dir() && std::fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Some(dir.to_string_lossy().into_owned());
    }
    None
}

fn run_semgrep(ctx: &ReviewContext) -> Vec<Finding> {
    let files = reviewable_abs_paths(ctx);
    if files.is_empty() {
        return Vec::new();
    }
    // Local-first: only run semgrep against an offline ruleset; never `--config auto`.
    let Some(config) = semgrep_config() else {
        return Vec::new();
    };
    let mut cmd = Command::new("semgrep");
    cmd.args(["--sarif", "--quiet", "--config", &config, "--metrics", "off"])
        .args(&files)
        .current_dir(&ctx.root);
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    parse_sarif(&out.stdout, ctx, "semgrep")
}

fn parse_sarif(bytes: &[u8], ctx: &ReviewContext, tool: &str) -> Vec<Finding> {
    let Ok(doc): Result<Value, _> = serde_json::from_slice(bytes) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let runs = doc.get("runs").and_then(|r| r.as_array());
    for run in runs.into_iter().flatten() {
        let results = run.get("results").and_then(|r| r.as_array());
        for res in results.into_iter().flatten() {
            let rule = res.get("ruleId").and_then(|v| v.as_str()).unwrap_or("rule");
            let level = res.get("level").and_then(|v| v.as_str()).unwrap_or("warning");
            let msg = res
                .get("message")
                .and_then(|m| m.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let loc = res
                .get("locations")
                .and_then(|l| l.as_array())
                .and_then(|a| a.first())
                .and_then(|l| l.get("physicalLocation"));
            let Some(pl) = loc else { continue };
            let uri = pl
                .get("artifactLocation")
                .and_then(|a| a.get("uri"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let line = pl
                .get("region")
                .and_then(|r| r.get("startLine"))
                .and_then(|v| v.as_u64())
                .unwrap_or(1) as u32;
            let rel = to_rel(ctx, uri);
            if !on_added_line(ctx, &rel, line) {
                continue;
            }
            out.push(Finding::new(
                &format!("{tool}.{rule}"),
                Category::Security,
                sarif_severity(level),
                &rel,
                Region::line(line),
                rule,
                msg,
                Anchor { kind: AnchorKind::Sarif, detail: format!("{tool}:{rule}") },
                0.7,
                tool,
                &format!("{rel}:{rule}:{line}"),
            ));
        }
    }
    out
}

fn sarif_severity(level: &str) -> Severity {
    match level {
        "error" => Severity::High,
        "warning" => Severity::Medium,
        _ => Severity::Low,
    }
}

// --- ast-grep (JSON) -------------------------------------------------------

fn run_astgrep(ctx: &ReviewContext) -> Vec<Finding> {
    // `ast-grep scan --json` emits an array of matches; only fires if the repo
    // has an sgconfig with rules. Graceful on any deviation.
    let Ok(out) = Command::new("ast-grep")
        .args(["scan", "--json"])
        .current_dir(&ctx.root)
        .output()
    else {
        return Vec::new();
    };
    let Ok(doc): Result<Value, _> = serde_json::from_slice(&out.stdout) else {
        return Vec::new();
    };
    let mut findings = Vec::new();
    for m in doc.as_array().into_iter().flatten() {
        let rule = m.get("ruleId").and_then(|v| v.as_str()).unwrap_or("ast-grep");
        let file = m.get("file").and_then(|v| v.as_str()).unwrap_or("");
        let line = m
            .get("range")
            .and_then(|r| r.get("start"))
            .and_then(|s| s.get("line"))
            .and_then(|v| v.as_u64())
            .map(|l| l as u32 + 1) // ast-grep lines are 0-based
            .unwrap_or(1);
        let msg = m.get("message").and_then(|v| v.as_str()).unwrap_or("");
        let sev = m.get("severity").and_then(|v| v.as_str()).unwrap_or("warning");
        let rel = to_rel(ctx, file);
        if !on_added_line(ctx, &rel, line) {
            continue;
        }
        findings.push(Finding::new(
            &format!("ast-grep.{rule}"),
            Category::Correctness,
            sarif_severity(sev),
            &rel,
            Region::line(line),
            rule,
            msg,
            Anchor { kind: AnchorKind::Sarif, detail: format!("ast-grep:{rule}") },
            0.7,
            "ast-grep",
            &format!("{rel}:{rule}:{line}"),
        ));
    }
    findings
}

// --- gitleaks (JSON) -------------------------------------------------------

fn run_gitleaks(ctx: &ReviewContext) -> Vec<Finding> {
    use crate::diff::DiffMode;
    // gitleaks `protect` scans uncommitted changes (the pre-commit workflow);
    // `--staged` narrows that to the index. Match the invocation to the review
    // mode so we never scan an empty staged index and silently report zero —
    // the old `--staged`-always behavior was a fail-open in working/base/all.
    // gitleaks has no cheap diff-scoped command for a committed range, and these
    // findings are not intersected with the changed-line set, so for base/all we
    // leave secret coverage to the pure-Rust `Secrets` collector (which scans
    // added lines in every mode) rather than scan the whole tree off-diff.
    let scan_args: &[&str] = match ctx.mode {
        DiffMode::Staged => {
            &["protect", "--staged", "--report-format", "json", "--report-path", "-", "--no-banner"]
        }
        DiffMode::Working => {
            &["protect", "--report-format", "json", "--report-path", "-", "--no-banner"]
        }
        DiffMode::Base(_) | DiffMode::All => return Vec::new(),
    };
    let Ok(out) = Command::new("gitleaks")
        .args(scan_args)
        .current_dir(&ctx.root)
        .output()
    else {
        return Vec::new();
    };
    let Ok(doc): Result<Value, _> = serde_json::from_slice(&out.stdout) else {
        return Vec::new();
    };
    let mut findings = Vec::new();
    for g in doc.as_array().into_iter().flatten() {
        let rule = g.get("RuleID").and_then(|v| v.as_str()).unwrap_or("secret");
        let desc = g.get("Description").and_then(|v| v.as_str()).unwrap_or("Secret detected");
        let file = g.get("File").and_then(|v| v.as_str()).unwrap_or("");
        let line = g.get("StartLine").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
        let rel = to_rel(ctx, file);
        findings.push(Finding::new(
            &format!("gitleaks.{rule}"),
            Category::Security,
            Severity::Critical,
            &rel,
            Region::line(line),
            "Secret detected (gitleaks)",
            desc,
            Anchor { kind: AnchorKind::Secret, detail: format!("gitleaks:{rule}") },
            0.9,
            "gitleaks",
            &format!("{rel}:{rule}:{line}"),
        ));
    }
    findings
}

// --- osv-scanner (JSON) ----------------------------------------------------

fn run_osv(ctx: &ReviewContext) -> Vec<Finding> {
    // A changed lockfile is only the trigger. Diff scanner results against the
    // base lockfile so long-standing vulnerabilities are not called introduced.
    let lockfiles: Vec<&str> = ctx
        .files
        .iter()
        .filter(|f| is_lockfile(&f.path))
        .map(|f| f.path.as_str())
        .collect();
    let mut findings = Vec::new();
    for lf in lockfiles {
        let abs = ctx.root.join(lf);
        let Some(head) = scan_osv_lockfile(&abs) else {
            continue;
        };
        let base_keys: HashSet<OsvKey> = match ctx.base_content(lf) {
            Some(content) => {
                let Some(base) = scan_osv_content(&content, lf) else {
                    continue;
                };
                base.into_iter().map(|v| v.key).collect()
            }
            None => HashSet::new(),
        };

        for vuln in only_new_osv(head, &base_keys) {
            findings.push(Finding::new(
                &format!("supplychain.{}", vuln.key.id),
                Category::Supplychain,
                Severity::High,
                lf,
                Region::line(1),
                &format!("Vulnerable dependency: {}", vuln.key.name),
                &format!(
                    "{}: {} (introduced/updated {}@{} in this change to {lf})",
                    vuln.key.id, vuln.summary, vuln.key.name, vuln.key.version
                ),
                Anchor { kind: AnchorKind::Vuln, detail: format!("osv:{}", vuln.key.id) },
                0.85,
                "osv-scanner",
                &format!(
                    "{lf}:{}:{}:{}:{}",
                    vuln.key.id, vuln.key.ecosystem, vuln.key.name, vuln.key.version
                ),
            ));
        }
    }
    findings
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct OsvKey {
    id: String,
    ecosystem: String,
    name: String,
    version: String,
}

#[derive(Debug, Clone)]
struct OsvVulnerability {
    key: OsvKey,
    summary: String,
}

fn scan_osv_content(content: &str, original_path: &str) -> Option<Vec<OsvVulnerability>> {
    let dir = tempdir().ok()?;
    let name = Path::new(original_path).file_name()?;
    let path = dir.path().join(name);
    let mut file = std::fs::File::create(&path).ok()?;
    file.write_all(content.as_bytes()).ok()?;
    scan_osv_lockfile(&path)
}

fn scan_osv_lockfile(path: &Path) -> Option<Vec<OsvVulnerability>> {
    let out = Command::new("osv-scanner")
        .args(["--format", "json", "--lockfile"])
        .arg(path)
        .output()
        .ok()?;
    parse_osv(&out.stdout)
}

fn parse_osv(bytes: &[u8]) -> Option<Vec<OsvVulnerability>> {
    let doc: Value = serde_json::from_slice(bytes).ok()?;
    let mut out = Vec::new();
    for result in doc.get("results").and_then(|r| r.as_array()).into_iter().flatten() {
        for pkg in result.get("packages").and_then(|p| p.as_array()).into_iter().flatten() {
            let package = pkg.get("package");
            let name = package.and_then(|p| p.get("name")).and_then(|v| v.as_str()).unwrap_or("dependency");
            let ecosystem = package.and_then(|p| p.get("ecosystem")).and_then(|v| v.as_str()).unwrap_or("unknown");
            let version = package.and_then(|p| p.get("version")).and_then(|v| v.as_str()).unwrap_or("unknown");
            for vuln in pkg.get("vulnerabilities").and_then(|v| v.as_array()).into_iter().flatten() {
                let id = vuln.get("id").and_then(|v| v.as_str()).unwrap_or("VULN");
                let summary = vuln.get("summary").and_then(|v| v.as_str()).unwrap_or("Known vulnerability");
                out.push(OsvVulnerability {
                    key: OsvKey {
                        id: id.to_string(),
                        ecosystem: ecosystem.to_string(),
                        name: name.to_string(),
                        version: version.to_string(),
                    },
                    summary: summary.to_string(),
                });
            }
        }
    }
    Some(out)
}

fn only_new_osv(head: Vec<OsvVulnerability>, base: &HashSet<OsvKey>) -> Vec<OsvVulnerability> {
    head.into_iter().filter(|v| !base.contains(&v.key)).collect()
}

fn is_lockfile(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    matches!(
        base.as_str(),
        "package-lock.json"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "cargo.lock"
            | "poetry.lock"
            | "composer.lock"
            | "gemfile.lock"
            | "go.sum"
            | "requirements.txt"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vuln(id: &str, name: &str, version: &str) -> OsvVulnerability {
        OsvVulnerability {
            key: OsvKey {
                id: id.into(),
                ecosystem: "npm".into(),
                name: name.into(),
                version: version.into(),
            },
            summary: "advisory".into(),
        }
    }

    #[test]
    fn parses_osv_results_with_package_identity() {
        let json = br#"{"results":[{"packages":[{
          "package":{"name":"esbuild","version":"0.24.2","ecosystem":"npm"},
          "vulnerabilities":[{"id":"GHSA-test","summary":"test advisory"}]
        }]}]}"#;
        let parsed = parse_osv(json).expect("valid osv json");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].key, vuln("GHSA-test", "esbuild", "0.24.2").key);
    }

    #[test]
    fn keeps_only_vulnerability_tuples_absent_from_base() {
        let existing = vuln("GHSA-old", "pkg", "1.0.0");
        let introduced = vuln("GHSA-new", "other", "2.0.0");
        let base = HashSet::from([existing.key.clone()]);
        let kept = only_new_osv(vec![existing, introduced.clone()], &base);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].key, introduced.key);
    }

    #[test]
    fn package_version_is_part_of_osv_identity() {
        assert_ne!(vuln("GHSA-test", "pkg", "1.0.0").key, vuln("GHSA-test", "pkg", "1.1.0").key);
    }
}
