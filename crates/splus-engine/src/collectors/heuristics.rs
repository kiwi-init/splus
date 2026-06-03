//! Diff-scoped syntactic heuristics — cheap, deterministic, language-gated,
//! and applied only to added lines. These are the lowest-trust anchor kind
//! (Heuristic); they default to low/medium severity and lean on high precision
//! via narrow patterns rather than broad ones.

use super::{Collector, Lang, ReviewContext};
use crate::model::{Anchor, AnchorKind, Category, Finding, Region, Severity};
use regex::Regex;
use std::sync::OnceLock;

struct Rule {
    id: &'static str,
    title: &'static str,
    re: Regex,
    severity: Severity,
    category: Category,
    confidence: f32,
    message: &'static str,
    /// None = all languages; Some = only these.
    langs: Option<&'static [Lang]>,
}

const JSISH: &[Lang] = &[Lang::TypeScript, Lang::JavaScript, Lang::Tsx, Lang::Jsx];

fn rules() -> &'static Vec<Rule> {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let rx = |s: &str| Regex::new(s).expect("valid heuristic regex");
        vec![
            Rule {
                id: "hygiene.merge-conflict-marker",
                title: "Merge conflict marker",
                re: rx(r"^(<{7}|={7}|>{7})(\s|$)"),
                severity: Severity::High,
                category: Category::Correctness,
                confidence: 0.97,
                message: "An unresolved merge-conflict marker was committed. This will not compile/parse.",
                langs: None,
            },
            Rule {
                id: "hygiene.debug-console",
                title: "Debug console statement",
                re: rx(r"console\.(log|debug|dir|table|trace)\s*\("),
                severity: Severity::Low,
                category: Category::Hygiene,
                confidence: 0.9,
                message: "A console debug statement was added. Remove it or use a structured logger.",
                langs: Some(JSISH),
            },
            Rule {
                id: "hygiene.debugger-statement",
                title: "`debugger` statement",
                re: rx(r"^\s*debugger\s*;?\s*$"),
                severity: Severity::Medium,
                category: Category::Hygiene,
                confidence: 0.95,
                message: "A `debugger` statement was added. Remove it before merging.",
                langs: Some(JSISH),
            },
            Rule {
                id: "correctness.focused-test",
                title: "Focused test",
                re: rx(r"\b(describe|it|test|context)\.only\s*\(|\bf(describe|it)\s*\("),
                severity: Severity::Medium,
                category: Category::Correctness,
                confidence: 0.92,
                message: "A focused test (.only/fdescribe/fit) was added — it will silently skip the rest of the suite in CI.",
                langs: Some(JSISH),
            },
            Rule {
                id: "correctness.skipped-test",
                title: "Skipped test",
                re: rx(r"\b(describe|it|test)\.skip\s*\(|\bx(describe|it)\s*\("),
                severity: Severity::Low,
                category: Category::Correctness,
                confidence: 0.8,
                message: "A skipped test was added. Confirm this is intentional.",
                langs: Some(JSISH),
            },
            Rule {
                id: "hygiene.introduced-todo",
                title: "New TODO/FIXME",
                re: rx(r"(?:^|\s)(?://|#|/\*)\s*(TODO|FIXME|HACK|XXX)\b"),
                severity: Severity::Info,
                category: Category::Hygiene,
                confidence: 0.7,
                message: "A new TODO/FIXME was introduced. Consider filing a tracked issue instead.",
                langs: None,
            },
            Rule {
                id: "security.eval-usage",
                title: "Dynamic eval",
                re: rx(r"\beval\s*\(|\bnew\s+Function\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.55,
                message: "`eval`/`new Function` was added. If any input is non-constant this is an injection sink — prefer a safe parser.",
                langs: Some(JSISH),
            },
            Rule {
                id: "security.child-process-shell",
                title: "Shell exec",
                re: rx(r"\b(exec|execSync)\s*\(\s*`|\bspawn\w*\s*\([^)]*shell\s*:\s*true"),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.55,
                message: "A shell exec with an interpolated/`shell:true` command was added. If any segment is user-controlled this is a command-injection sink.",
                langs: Some(JSISH),
            },
            Rule {
                id: "hygiene.eslint-disable",
                title: "ESLint disable",
                re: rx(r"//\s*eslint-disable"),
                severity: Severity::Info,
                category: Category::Hygiene,
                confidence: 0.75,
                message: "A new `eslint-disable` was added — confirm the lint rule is being suppressed for a good reason.",
                langs: Some(JSISH),
            },
            Rule {
                id: "correctness.python-bare-except",
                title: "Bare except",
                re: rx(r"^\s*except\s*:\s*$"),
                severity: Severity::Low,
                category: Category::Correctness,
                confidence: 0.85,
                message: "A bare `except:` was added — it swallows KeyboardInterrupt/SystemExit. Catch a specific exception.",
                langs: Some(&[Lang::Python]),
            },
            Rule {
                id: "hygiene.python-print",
                title: "Debug print",
                re: rx(r"^\s*print\s*\("),
                severity: Severity::Info,
                category: Category::Hygiene,
                confidence: 0.5,
                message: "A `print(` was added — if this is debug output, use logging instead.",
                langs: Some(&[Lang::Python]),
            },
            // ── high-precision security sinks (native, local, diff-scoped) ──────
            // Conservative patterns: each is a well-known sink whose mere presence
            // on a new line warrants a look. Precision over recall — deep taint /
            // SSRF nuance is left to the agent's discovery pass.
            Rule {
                id: "security.python-yaml-load",
                title: "Unsafe YAML load",
                re: rx(r"\byaml\.load\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.6,
                message: "`yaml.load(` without `Loader=SafeLoader` deserializes arbitrary Python objects (RCE on untrusted input). Use `yaml.safe_load(`.",
                langs: Some(&[Lang::Python]),
            },
            Rule {
                id: "security.python-pickle-load",
                title: "Untrusted pickle deserialization",
                re: rx(r"\bpickle\.loads?\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.55,
                message: "`pickle.load(s)` executes arbitrary code during deserialization. Never unpickle untrusted data — use a safe format (JSON) at trust boundaries.",
                langs: Some(&[Lang::Python]),
            },
            Rule {
                id: "security.python-eval-exec",
                title: "Dynamic eval/exec",
                re: rx(r"^\s*(eval|exec)\s*\(|[^.\w](eval|exec)\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.5,
                message: "`eval`/`exec` on any non-constant input is a code-injection sink. Prefer explicit parsing/dispatch.",
                langs: Some(&[Lang::Python]),
            },
            Rule {
                id: "security.python-subprocess-shell",
                title: "Shell=True subprocess",
                re: rx(r"\bsubprocess\.\w+\s*\([^)]*shell\s*=\s*True|\bos\.(system|popen)\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.6,
                message: "A shell invocation (`shell=True` / `os.system` / `os.popen`) was added. If any segment is user-controlled this is a command-injection sink — pass an argv list without a shell.",
                langs: Some(&[Lang::Python]),
            },
            Rule {
                id: "security.python-sql-fstring",
                title: "SQL built by string interpolation",
                // The operator must sit OUTSIDE the string literal (real
                // interpolation) — a `%s`/`%d` placeholder *inside* the string is
                // a parameterized query and must NOT trip this rule.
                re: rx(r#"\.execute\w*\s*\(\s*(f["']|[^)]*["']\s*[%+]|[^)]*["']\.format\s*\()"#),
                severity: Severity::High,
                category: Category::Security,
                confidence: 0.6,
                message: "SQL passed to `.execute(` is built by f-string / `%` / `+` / `.format` interpolation — a SQL-injection sink. Use parameterized queries (placeholders + params).",
                langs: Some(&[Lang::Python]),
            },
            Rule {
                id: "security.tls-verify-disabled",
                title: "TLS verification disabled",
                re: rx(r"\bverify\s*=\s*False|\brejectUnauthorized\s*:\s*false"),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.85,
                message: "TLS certificate verification is disabled — this exposes the connection to MITM. Remove it or pin a trusted CA bundle.",
                langs: None,
            },
            Rule {
                id: "security.js-sql-template",
                title: "SQL built by template literal",
                re: rx(r"\.(query|execute|raw)\s*\(\s*`[^`]*\$\{"),
                severity: Severity::High,
                category: Category::Security,
                confidence: 0.6,
                message: "SQL passed to `.query/.execute/.raw` is built with a `${…}` template literal — a SQL-injection sink. Use parameterized queries.",
                langs: Some(JSISH),
            },
            Rule {
                id: "security.js-dangerous-html",
                title: "dangerouslySetInnerHTML",
                re: rx(r"dangerouslySetInnerHTML"),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.5,
                message: "`dangerouslySetInnerHTML` renders raw HTML — an XSS sink unless the value is sanitized (e.g. DOMPurify).",
                langs: Some(JSISH),
            },
        ]
    })
}

pub struct Heuristics;

impl Collector for Heuristics {
    fn name(&self) -> &'static str {
        "heuristics"
    }

    fn run(&self, ctx: &ReviewContext) -> Vec<Finding> {
        let mut out = Vec::new();
        for file in ctx.reviewable_files() {
            let lang = Lang::from_path(&file.path);
            for added in &file.added {
                let text = &added.text;
                for rule in rules() {
                    if let Some(langs) = rule.langs {
                        if !langs.contains(&lang) {
                            continue;
                        }
                    }
                    if rule.re.is_match(text) {
                        let region = Region::line(added.line);
                        out.push(Finding::new(
                            rule.id,
                            rule.category,
                            rule.severity,
                            &file.path,
                            region,
                            rule.title,
                            rule.message,
                            Anchor {
                                kind: AnchorKind::Heuristic,
                                detail: format!("pattern {}", rule.id),
                            },
                            rule.confidence,
                            "heuristics",
                            &crate::util::normalize_snippet(text),
                        ));
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::DiffMode;
    use crate::model::{AddedLine, ChangedFile};
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn ctx(path: &str, lines: &[(u32, &str)]) -> ReviewContext {
        let mut added = Vec::new();
        let mut set = BTreeSet::new();
        for (n, t) in lines {
            added.push(AddedLine { line: *n, text: t.to_string() });
            set.insert(*n);
        }
        ReviewContext {
            root: PathBuf::from("."),
            mode: DiffMode::Working,
            scip: None,
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
    fn flags_console_log_in_ts_not_py() {
        let c = ctx("src/a.ts", &[(5, "  console.log('debug', user)")]);
        let f = Heuristics.run(&c);
        assert!(f.iter().any(|x| x.rule_id == "hygiene.debug-console"));

        let c2 = ctx("src/a.py", &[(5, "  console.log('x')")]); // not JS → no match
        assert!(!Heuristics.run(&c2).iter().any(|x| x.rule_id == "hygiene.debug-console"));
    }

    #[test]
    fn flags_focused_test_and_conflict() {
        let c = ctx("a.test.ts", &[(1, "describe.only('x', () => {})")]);
        assert!(Heuristics.run(&c).iter().any(|x| x.rule_id == "correctness.focused-test"));

        let c2 = ctx("a.ts", &[(1, "<<<<<<< HEAD")]);
        assert!(Heuristics.run(&c2).iter().any(|x| x.rule_id == "hygiene.merge-conflict-marker"));
    }

    #[test]
    fn flags_python_security_sinks() {
        let has = |path: &str, line: &str, rule: &str| {
            Heuristics.run(&ctx(path, &[(1, line)])).iter().any(|x| x.rule_id == rule)
        };
        assert!(has("a.py", "    data = yaml.load(raw)", "security.python-yaml-load"));
        assert!(has("a.py", "    obj = pickle.loads(blob)", "security.python-pickle-load"));
        assert!(has("a.py", "    subprocess.run(cmd, shell=True)", "security.python-subprocess-shell"));
        assert!(has("a.py", "    cur.execute(f\"SELECT * FROM t WHERE id={uid}\")", "security.python-sql-fstring"));
        assert!(has("a.py", "    requests.get(url, verify=False)", "security.tls-verify-disabled"));
        // precision guards: safe forms must NOT trip
        assert!(!has("a.py", "    data = yaml.safe_load(raw)", "security.python-yaml-load"));
        assert!(!has("a.py", "    cur.execute(\"SELECT 1\", (uid,))", "security.python-sql-fstring"));
        // a `%s`/`%d` placeholder INSIDE the string is parameterized — not a sink
        assert!(!has("a.py", "    cur.execute(\"SELECT * FROM t WHERE id = %s\", (uid,))", "security.python-sql-fstring"));
        // but `%`/`+` OUTSIDE the string IS interpolation → must trip
        assert!(has("a.py", "    cur.execute(\"SELECT * FROM t WHERE id = \" + uid)", "security.python-sql-fstring"));
        assert!(has("a.py", "    cur.execute(\"SELECT %s\" % uid)", "security.python-sql-fstring"));
        // language gating: python rule must not fire on a .ts file
        assert!(!has("a.ts", "    obj = pickle.loads(blob)", "security.python-pickle-load"));
    }

    #[test]
    fn flags_js_security_sinks() {
        let has = |path: &str, line: &str, rule: &str| {
            Heuristics.run(&ctx(path, &[(1, line)])).iter().any(|x| x.rule_id == rule)
        };
        assert!(has("a.ts", "  db.query(`SELECT * FROM u WHERE id=${id}`)", "security.js-sql-template"));
        assert!(has("a.tsx", "  return <div dangerouslySetInnerHTML={{__html: x}} />", "security.js-dangerous-html"));
        assert!(has("a.ts", "  const agent = new https.Agent({ rejectUnauthorized: false })", "security.tls-verify-disabled"));
        // parameterized query must not trip
        assert!(!has("a.ts", "  db.query('SELECT * FROM u WHERE id=$1', [id])", "security.js-sql-template"));
    }
}
