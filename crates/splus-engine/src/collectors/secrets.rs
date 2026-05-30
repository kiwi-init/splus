//! Secret detection — gitleaks-style regex rules + Shannon-entropy gating,
//! scoped to added lines only. Pure Rust, no external tools, zero inference.
//!
//! Default secrets engine (gitleaks is MIT; trufflehog live-verification is an
//! opt-in AGPL adapter handled elsewhere). Entropy gating on the generic rule
//! keeps the false-positive rate down.

use super::{Collector, ReviewContext};
use crate::model::{Anchor, AnchorKind, Category, Finding, Region, Severity};
use crate::util::shannon_entropy;
use regex::Regex;
use std::sync::OnceLock;

struct SecretRule {
    id: &'static str,
    title: &'static str,
    re: Regex,
    severity: Severity,
    /// If set, the value (capture group 1, else whole match) must exceed this
    /// entropy (bits/char) to fire — kills low-entropy placeholder FPs.
    min_entropy: Option<f64>,
    confidence: f32,
}

fn rules() -> &'static Vec<SecretRule> {
    static RULES: OnceLock<Vec<SecretRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let r = |s: &str| Regex::new(s).expect("valid secret regex");
        vec![
            SecretRule {
                id: "secret.aws-access-key-id",
                title: "AWS Access Key ID",
                re: r(r"\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b"),
                severity: Severity::Critical,
                min_entropy: None,
                confidence: 0.95,
            },
            SecretRule {
                id: "secret.aws-secret-access-key",
                title: "AWS Secret Access Key",
                re: r#"(?i)aws_?secret_?(access_?)?key\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?"#
                    .parse_rule(),
                severity: Severity::Critical,
                min_entropy: Some(4.0),
                confidence: 0.9,
            },
            SecretRule {
                id: "secret.github-token",
                title: "GitHub token",
                re: r("\\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\\b"),
                severity: Severity::Critical,
                min_entropy: None,
                confidence: 0.95,
            },
            SecretRule {
                id: "secret.openai-anthropic-key",
                title: "LLM provider API key (sk-…)",
                re: r("\\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\\b"),
                severity: Severity::Critical,
                min_entropy: Some(3.2),
                confidence: 0.9,
            },
            SecretRule {
                id: "secret.slack-token",
                title: "Slack token",
                re: r("\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b"),
                severity: Severity::High,
                min_entropy: None,
                confidence: 0.9,
            },
            SecretRule {
                id: "secret.google-api-key",
                title: "Google API key",
                re: r("\\bAIza[0-9A-Za-z_-]{35}\\b"),
                severity: Severity::High,
                min_entropy: None,
                confidence: 0.9,
            },
            SecretRule {
                id: "secret.private-key",
                title: "Private key material",
                re: r("-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"),
                severity: Severity::Critical,
                min_entropy: None,
                confidence: 0.97,
            },
            SecretRule {
                id: "secret.jwt",
                title: "Hardcoded JWT",
                re: r("\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b"),
                severity: Severity::High,
                min_entropy: Some(3.5),
                confidence: 0.75,
            },
            // Generic: assignment of a secret-ish name to a high-entropy literal.
            SecretRule {
                id: "secret.generic-high-entropy",
                title: "Possible hardcoded credential",
                re: r#"(?i)(password|passwd|secret|token|api_?key|access_?key|auth)\s*[:=]\s*['"]([^'"\s]{12,})['"]"#
                    .parse_rule(),
                severity: Severity::High,
                min_entropy: Some(3.5),
                confidence: 0.6,
            },
        ]
    })
}

/// Tiny helper so the inline raw-string rules above read cleanly.
trait ParseRule {
    fn parse_rule(self) -> Regex;
}
impl ParseRule for &str {
    fn parse_rule(self) -> Regex {
        Regex::new(self).expect("valid secret regex")
    }
}

pub struct Secrets;

impl Collector for Secrets {
    fn name(&self) -> &'static str {
        "secrets"
    }

    fn run(&self, ctx: &ReviewContext) -> Vec<Finding> {
        let mut out = Vec::new();
        for file in ctx.reviewable_files() {
            for added in &file.added {
                let line = &added.text;
                // Skip obvious non-secrets fast.
                if line.len() < 12 {
                    continue;
                }
                for rule in rules() {
                    if let Some(m) = rule.re.captures(line) {
                        // The "value" is the last capture group if present, else
                        // the whole match — that's what we entropy-check.
                        let value = m
                            .iter()
                            .skip(1)
                            .flatten()
                            .last()
                            .map(|x| x.as_str())
                            .unwrap_or_else(|| m.get(0).unwrap().as_str());

                        if let Some(min) = rule.min_entropy {
                            if shannon_entropy(value) < min {
                                continue;
                            }
                        }
                        // Reduce FPs: ignore lines that look like examples/tests.
                        if is_placeholder(line) {
                            continue;
                        }

                        let region = Region::line(added.line);
                        let msg = format!(
                            "{} detected on an added line. Remove the secret, rotate it, and load it from a secret manager or environment variable.",
                            rule.title
                        );
                        out.push(Finding::new(
                            rule.id,
                            Category::Security,
                            rule.severity,
                            &file.path,
                            region,
                            rule.title,
                            &msg,
                            Anchor {
                                kind: AnchorKind::Secret,
                                detail: format!("pattern {} (entropy {:.1})", rule.id, shannon_entropy(value)),
                            },
                            rule.confidence,
                            "secrets",
                            // Fingerprint on the matched value, not the line number.
                            value,
                        ));
                        break; // one secret finding per line is enough
                    }
                }
            }
        }
        out
    }
}

/// Heuristic: lines that are clearly placeholders/examples shouldn't alarm.
fn is_placeholder(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "example",
        "your_",
        "xxxx",
        "placeholder",
        "dummy",
        "<token>",
        "redacted",
        "changeme",
        "process.env",
        "os.environ",
        "getenv",
    ];
    NEEDLES.iter().any(|n| l.contains(n))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::DiffMode;
    use crate::model::{AddedLine, ChangedFile};
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn ctx_with(path: &str, lines: &[(u32, &str)]) -> ReviewContext {
        let mut added = Vec::new();
        let mut set = BTreeSet::new();
        for (n, t) in lines {
            added.push(AddedLine { line: *n, text: t.to_string() });
            set.insert(*n);
        }
        ReviewContext {
            root: PathBuf::from("."),
            mode: DiffMode::Working,
            files: vec![ChangedFile {
                path: path.to_string(),
                added,
                added_set: set,
                removed_count: 0,
                is_new: false,
                is_deleted: false,
            }],
        }
    }

    #[test]
    fn detects_aws_key() {
        let c = ctx_with("src/config.ts", &[(3, "const k = \"AKIAIOSFODNN7EXAMPLE\";")]);
        // "EXAMPLE" placeholder is filtered — good (no FP).
        let f = Secrets.run(&c);
        assert!(f.is_empty());

        let c2 = ctx_with("src/config.ts", &[(3, "const k = \"AKIA1B2C3D4E5F6G7H8I\";")]);
        let f2 = Secrets.run(&c2);
        assert_eq!(f2.len(), 1);
        assert_eq!(f2[0].rule_id, "secret.aws-access-key-id");
    }

    #[test]
    fn entropy_gate_rejects_low_entropy_generic() {
        let c = ctx_with("a.ts", &[(1, "const password = \"aaaaaaaaaaaa\";")]);
        assert!(Secrets.run(&c).is_empty());
        let c2 = ctx_with("a.ts", &[(1, "const password = \"G7$kP9vXm2qZ\";")]);
        assert_eq!(Secrets.run(&c2).len(), 1);
    }

    #[test]
    fn env_var_is_not_a_secret() {
        let c = ctx_with("a.ts", &[(1, "const token = process.env.API_TOKEN;")]);
        assert!(Secrets.run(&c).is_empty());
    }
}
