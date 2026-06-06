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
const GO: &[Lang] = &[Lang::Go];
const RUST: &[Lang] = &[Lang::Rust];
const JVM: &[Lang] = &[Lang::Java, Lang::Kotlin]; // share the JDK exec/deser/SQL APIs
const CSHARP: &[Lang] = &[Lang::CSharp];
const CFAMILY: &[Lang] = &[Lang::C, Lang::Cpp];
const PHP: &[Lang] = &[Lang::Php];
const RUBY: &[Lang] = &[Lang::Ruby];
const BASH: &[Lang] = &[Lang::Bash];

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
            // ── Go ──────────────────────────────────────────────────────────
            Rule {
                id: "security.go-tls-insecure",
                title: "TLS verification disabled (Go)",
                re: rx(r"InsecureSkipVerify\s*:\s*true"),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.85,
                message: "`InsecureSkipVerify: true` disables TLS certificate validation — the connection is exposed to MITM. Remove it or pin a trusted CA pool.",
                langs: Some(GO),
            },
            Rule {
                id: "security.go-exec-shell",
                title: "Shell exec (Go)",
                re: rx(r#"exec\.Command\s*\(\s*"(sh|bash|cmd)"\s*,\s*"(-c|/c|/C)""#),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.55,
                message: "`exec.Command(\"sh\", \"-c\", …)` runs a string through a shell. If any segment is user-controlled this is a command-injection sink — pass args directly without a shell.",
                langs: Some(GO),
            },
            Rule {
                id: "security.go-sql-sprintf",
                title: "SQL built by fmt.Sprintf (Go)",
                re: rx(r"\.(Query|QueryRow|Exec)\w*\s*\(\s*fmt\.Sprintf\s*\("),
                severity: Severity::High,
                category: Category::Security,
                confidence: 0.6,
                message: "SQL passed to `.Query/.Exec` is built with `fmt.Sprintf` — a SQL-injection sink. Use parameterized queries (`$1`/`?` placeholders + args).",
                langs: Some(GO),
            },
            // ── Rust ────────────────────────────────────────────────────────
            Rule {
                id: "security.rust-unsafe-block",
                title: "`unsafe` block",
                re: rx(r"\bunsafe\s*\{"),
                severity: Severity::Info,
                category: Category::Correctness,
                confidence: 0.5,
                message: "An `unsafe` block was added — it opts out of the borrow/aliasing checks. Confirm the invariants it relies on are upheld and documented.",
                langs: Some(RUST),
            },
            Rule {
                id: "security.rust-tls-insecure",
                title: "TLS verification disabled (Rust)",
                re: rx(r"danger_accept_invalid_certs\s*\(\s*true\s*\)"),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.85,
                message: "`danger_accept_invalid_certs(true)` disables TLS certificate validation — exposes the connection to MITM. Remove it or configure a trusted root store.",
                langs: Some(RUST),
            },
            // ── JVM (Java / Kotlin) ───────────────────────────────────────────
            Rule {
                id: "security.jvm-runtime-exec",
                title: "Runtime.exec",
                re: rx(r"\.getRuntime\s*\(\s*\)\s*\.exec\s*\(|ProcessBuilder\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.5,
                message: "A process exec (`Runtime.exec` / `ProcessBuilder`) was added. If any argument is user-controlled this is a command-injection sink — avoid a shell and validate inputs.",
                langs: Some(JVM),
            },
            Rule {
                id: "security.jvm-deserialization",
                title: "Unsafe Java deserialization",
                re: rx(r"new\s+ObjectInputStream\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.6,
                message: "`ObjectInputStream` deserializes arbitrary Java objects — a well-known RCE gadget sink on untrusted input. Prefer a safe format (JSON) at trust boundaries.",
                langs: Some(JVM),
            },
            Rule {
                id: "security.jvm-sql-concat",
                title: "SQL built by string concatenation (JVM)",
                re: rx(r#"\.(executeQuery|executeUpdate|execute)\s*\(\s*"[^"]*"\s*\+"#),
                severity: Severity::High,
                category: Category::Security,
                confidence: 0.6,
                message: "SQL passed to `execute*` is built by string concatenation — a SQL-injection sink. Use a `PreparedStatement` with bound parameters.",
                langs: Some(JVM),
            },
            // ── C# ─────────────────────────────────────────────────────────────
            Rule {
                id: "security.csharp-process-start",
                title: "Process.Start",
                re: rx(r"Process\.Start\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.5,
                message: "`Process.Start` was added. If any argument is user-controlled this is a command-injection sink — avoid `UseShellExecute` with untrusted input.",
                langs: Some(CSHARP),
            },
            Rule {
                id: "security.csharp-sql-concat",
                title: "SQL built by string concatenation (C#)",
                re: rx(r#"new\s+SqlCommand\s*\(\s*"[^"]*"\s*\+|\.(ExecuteReader|ExecuteNonQuery|ExecuteScalar)\s*\(\s*"[^"]*"\s*\+"#),
                severity: Severity::High,
                category: Category::Security,
                confidence: 0.6,
                message: "SQL is built by string concatenation — a SQL-injection sink. Use parameterized commands (`SqlParameter` / `@p`).",
                langs: Some(CSHARP),
            },
            // ── C / C++ ────────────────────────────────────────────────────────
            Rule {
                id: "security.c-unsafe-strfn",
                title: "Unsafe C string function",
                re: rx(r"\b(strcpy|strcat|sprintf|gets)\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.6,
                message: "An unbounded string function (`strcpy`/`strcat`/`sprintf`/`gets`) was added — a classic buffer-overflow sink. Use the bounded variants (`strncpy`/`snprintf`/`fgets`).",
                langs: Some(CFAMILY),
            },
            Rule {
                id: "security.c-system-exec",
                title: "system()/popen()",
                re: rx(r"\b(system|popen)\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.55,
                message: "`system`/`popen` runs a command through a shell. If any part is user-controlled this is a command-injection sink — use `exec*`/`posix_spawn` with an argv array.",
                langs: Some(CFAMILY),
            },
            // ── PHP ────────────────────────────────────────────────────────────
            Rule {
                id: "security.php-eval",
                title: "Dynamic eval (PHP)",
                re: rx(r"\beval\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.55,
                message: "`eval(` on any non-constant input is a code-injection sink. Prefer explicit parsing/dispatch.",
                langs: Some(PHP),
            },
            Rule {
                id: "security.php-shell",
                title: "Shell exec (PHP)",
                re: rx(r"\b(shell_exec|exec|system|passthru|proc_open)\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.55,
                message: "A shell-exec function (`shell_exec`/`exec`/`system`/`passthru`/`proc_open`) was added. If any argument is user-controlled this is a command-injection sink — use `escapeshellarg`/avoid the shell.",
                langs: Some(PHP),
            },
            Rule {
                id: "security.php-unserialize",
                title: "Untrusted unserialize (PHP)",
                re: rx(r"\bunserialize\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.55,
                message: "`unserialize(` on untrusted input enables PHP object injection (gadget-chain RCE). Use `json_decode` at trust boundaries.",
                langs: Some(PHP),
            },
            // ── Ruby ───────────────────────────────────────────────────────────
            Rule {
                id: "security.ruby-eval",
                title: "Dynamic eval (Ruby)",
                re: rx(r"\b(eval|instance_eval|class_eval)\s*[\(\s]"),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.5,
                message: "`eval`/`instance_eval`/`class_eval` on any non-constant input is a code-injection sink. Prefer explicit dispatch.",
                langs: Some(RUBY),
            },
            Rule {
                id: "security.ruby-marshal-load",
                title: "Untrusted Marshal.load (Ruby)",
                re: rx(r"\bMarshal\.load\s*\("),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.55,
                message: "`Marshal.load` deserializes arbitrary Ruby objects — RCE on untrusted input. Use a safe format (JSON) at trust boundaries.",
                langs: Some(RUBY),
            },
            Rule {
                id: "security.ruby-html-safe",
                title: "html_safe / raw output (Ruby)",
                re: rx(r"\.html_safe\b|\braw\s*\("),
                severity: Severity::Low,
                category: Category::Security,
                confidence: 0.5,
                message: "`html_safe`/`raw` marks a string as not-to-be-escaped — an XSS sink if it contains user input. Let the view auto-escape, or sanitize first.",
                langs: Some(RUBY),
            },
            // ── Bash / Shell ───────────────────────────────────────────────────
            Rule {
                id: "security.bash-curl-pipe-shell",
                title: "Pipe-to-shell install",
                re: rx(r"\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b"),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.7,
                message: "A `curl … | sh` pipe-to-shell was added — it executes remote code with no integrity check. Download, inspect, then run, or verify a checksum/signature.",
                langs: Some(BASH),
            },
            Rule {
                id: "security.bash-eval",
                title: "eval of dynamic string (Bash)",
                re: rx(r"^\s*eval\s+\S|\beval\s+[\x22\x27$]"),
                severity: Severity::Medium,
                category: Category::Security,
                confidence: 0.55,
                message: "`eval` of a constructed string is a command-injection sink in shell. Avoid `eval`; use arrays or explicit dispatch.",
                langs: Some(BASH),
            },
            Rule {
                id: "security.bash-rm-rf-var",
                title: "rm -rf with a variable",
                re: rx(r"\brm\s+-[rR]f?\s+[^\n]*\$"),
                severity: Severity::Medium,
                category: Category::Correctness,
                confidence: 0.55,
                message: "`rm -rf` with an unguarded variable can wipe the wrong tree if the variable is empty/unexpected. Quote it and guard against empty (`${x:?}`).",
                langs: Some(BASH),
            },
            Rule {
                id: "hygiene.bash-chmod-777",
                title: "chmod 777",
                re: rx(r"\bchmod\s+(-R\s+)?0?777\b"),
                severity: Severity::Low,
                category: Category::Security,
                confidence: 0.7,
                message: "`chmod 777` grants world write+execute. Scope the permissions to what's actually needed.",
                langs: Some(BASH),
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

    #[test]
    fn flags_multilang_security_sinks() {
        let has = |path: &str, line: &str, rule: &str| {
            Heuristics.run(&ctx(path, &[(1, line)])).iter().any(|x| x.rule_id == rule)
        };
        // Go
        assert!(has("a.go", "  tls.Config{InsecureSkipVerify: true}", "security.go-tls-insecure"));
        assert!(has("a.go", "  exec.Command(\"sh\", \"-c\", cmd)", "security.go-exec-shell"));
        assert!(has("a.go", "  db.Query(fmt.Sprintf(\"SELECT %s\", c))", "security.go-sql-sprintf"));
        // Rust
        assert!(has("a.rs", "  unsafe { *p = 1; }", "security.rust-unsafe-block"));
        assert!(has("a.rs", "  .danger_accept_invalid_certs(true)", "security.rust-tls-insecure"));
        // JVM — same rule on Java and Kotlin
        assert!(has("a.java", "  Runtime.getRuntime().exec(cmd)", "security.jvm-runtime-exec"));
        assert!(has("a.kt", "  Runtime.getRuntime().exec(cmd)", "security.jvm-runtime-exec"));
        assert!(has("a.java", "  new ObjectInputStream(in)", "security.jvm-deserialization"));
        assert!(has("a.java", "  st.executeQuery(\"SELECT * FROM t WHERE id=\" + id)", "security.jvm-sql-concat"));
        // C#
        assert!(has("a.cs", "  Process.Start(psi)", "security.csharp-process-start"));
        assert!(has("a.cs", "  new SqlCommand(\"SELECT \" + id, conn)", "security.csharp-sql-concat"));
        // C / C++
        assert!(has("a.c", "  strcpy(dst, src);", "security.c-unsafe-strfn"));
        assert!(has("a.cpp", "  system(cmd.c_str());", "security.c-system-exec"));
        // PHP
        assert!(has("a.php", "  eval($code);", "security.php-eval"));
        assert!(has("a.php", "  shell_exec($cmd);", "security.php-shell"));
        assert!(has("a.php", "  $o = unserialize($raw);", "security.php-unserialize"));
        // Ruby
        assert!(has("a.rb", "  eval(code)", "security.ruby-eval"));
        assert!(has("a.rb", "  Marshal.load(blob)", "security.ruby-marshal-load"));
        assert!(has("a.rb", "  @x = user_input.html_safe", "security.ruby-html-safe"));
        // Bash
        assert!(has("deploy.sh", "  curl https://x.sh | sh", "security.bash-curl-pipe-shell"));
        assert!(has("deploy.sh", "  eval \"$cmd\"", "security.bash-eval"));
        assert!(has("deploy.sh", "  rm -rf $TARGET/build", "security.bash-rm-rf-var"));
        assert!(has("deploy.sh", "  chmod 777 /srv", "hygiene.bash-chmod-777"));

        // ── language gating + precision guards ──────────────────────────────
        // Go rule must not fire on a TS file.
        assert!(!has("a.ts", "  cfg.InsecureSkipVerify = true", "security.go-tls-insecure"));
        // PHP eval must not fire on a JS file (JS has its own eval rule).
        assert!(!has("a.js", "  eval(code)", "security.php-eval"));
        // Parameterized JVM query (no concatenation) must not trip.
        assert!(!has("a.java", "  st.executeQuery(\"SELECT * FROM t WHERE id=?\")", "security.jvm-sql-concat"));
        // A bounded C string fn is fine.
        assert!(!has("a.c", "  snprintf(dst, n, \"%s\", src);", "security.c-unsafe-strfn"));
    }
}
