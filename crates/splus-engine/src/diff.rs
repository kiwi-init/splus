//! Git integration + unified-diff parsing → clean-as-you-code changed-line sets.
//!
//! The single most important noise-control lever: we only ever review *new* code
//! (added lines in the diff), never re-flagging unchanged/legacy lines.

use crate::model::{AddedLine, ChangedFile};
use anyhow::{bail, Context, Result};
use std::path::Path;
use std::process::Command;

/// Git's canonical empty tree — diffing against it makes every file look added.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// What slice of history to review.
#[derive(Debug, Clone)]
pub enum DiffMode {
    /// `git diff --cached` — staged changes (the pre-commit case).
    Staged,
    /// `git diff HEAD` — all uncommitted (staged + unstaged) vs HEAD.
    Working,
    /// `git diff <base>...HEAD` — PR-style (merge-base of base and HEAD).
    Base(String),
    /// The entire committed repository, reviewed as if newly added.
    All,
}

impl DiffMode {
    /// The ref representing the "before" state, for base-content lookups
    /// (cognitive-complexity delta, signature diff).
    pub fn base_ref(&self) -> String {
        match self {
            DiffMode::Staged | DiffMode::Working => "HEAD".to_string(),
            DiffMode::Base(b) => b.clone(),
            DiffMode::All => EMPTY_TREE.to_string(),
        }
    }
}

/// Run a git command in `root`, returning stdout. Errors include stderr.
pub fn git(root: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .with_context(|| format!("failed to spawn git {args:?}"))?;
    if !out.status.success() {
        bail!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn is_git_repo(root: &Path) -> bool {
    git(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// Produce the unified diff patch for the requested mode.
pub fn diff_patch(root: &Path, mode: &DiffMode) -> Result<String> {
    // A base ref starting with `-` would be parsed by git as an option, not a
    // revision (e.g. `--output=<file>` → arbitrary file write, `--ext-diff` →
    // re-enables external diff drivers). Reject it before it reaches git.
    if let DiffMode::Base(b) = mode {
        if b.starts_with('-') {
            bail!("invalid base ref {b:?}: refs cannot start with '-'");
        }
    }
    let args: Vec<String> = match mode {
        DiffMode::Staged => vec![
            "diff", "--cached", "--no-color", "--unified=3", "--no-ext-diff",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        DiffMode::Working => vec![
            "diff", "HEAD", "--no-color", "--unified=3", "--no-ext-diff",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        // Options first, then the revision range, then `--` to terminate options
        // so the range can never be reinterpreted as a flag.
        DiffMode::Base(b) => vec![
            "diff".to_string(),
            "--no-color".to_string(),
            "--unified=3".to_string(),
            "--no-ext-diff".to_string(),
            format!("{b}...HEAD"),
            "--".to_string(),
        ],
        DiffMode::All => vec![
            "diff", "--no-color", "--unified=3", "--no-ext-diff", EMPTY_TREE, "HEAD",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
    };
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git(root, &refs)
}

/// Read file content at a git ref (e.g. base content for delta analysis).
/// Returns None if the path didn't exist at that ref.
pub fn show_at_ref(root: &Path, refspec: &str, path: &str) -> Option<String> {
    git(root, &["show", &format!("{refspec}:{path}")]).ok()
}

/// Parse a unified diff into per-file changed-line sets.
///
/// We track the *new-file* line number for every added/context line so the
/// added set maps to lines as they exist in the working tree / head.
pub fn parse_unified_diff(patch: &str) -> Vec<ChangedFile> {
    let mut files: Vec<ChangedFile> = Vec::new();
    let mut cur: Option<ChangedFile> = None;
    let mut new_line: u32 = 0;
    // The `--- `/`+++ ` file headers only appear once per file, before its first
    // `@@` hunk. Once inside a hunk, a line starting with `--- `/`+++ ` is added
    // or removed CONTENT (e.g. a SQL/Lua comment `-- x`, or a `++ y` source line)
    // — not a header. Gating header detection on this flag stops such content
    // from corrupting `f.path` and (for `+++ `) silently failing to advance
    // `new_line`, which would drift every later anchor in the hunk.
    let mut in_hunk = false;

    for raw in patch.lines() {
        if let Some(rest) = raw.strip_prefix("diff --git ") {
            if let Some(f) = cur.take() {
                files.push(f);
            }
            let mut cf = ChangedFile::default();
            // Fallback path from "a/x b/y"; refined by the +++ header below.
            if let Some(b) = rest.split(" b/").nth(1) {
                cf.path = b.to_string();
            }
            cur = Some(cf);
            in_hunk = false;
        } else if !in_hunk && raw.starts_with("--- ") {
            if let Some(f) = cur.as_mut() {
                if raw.trim_end() == "--- /dev/null" {
                    f.is_new = true;
                }
            }
        } else if let Some(p) = raw.strip_prefix("+++ ").filter(|_| !in_hunk) {
            if let Some(f) = cur.as_mut() {
                let p = p.trim();
                if p == "/dev/null" {
                    f.is_deleted = true;
                } else {
                    f.path = p.strip_prefix("b/").unwrap_or(p).to_string();
                }
            }
        } else if raw.starts_with("@@") {
            in_hunk = true;
            new_line = parse_hunk_new_start(raw).unwrap_or(new_line);
        } else if let Some(f) = cur.as_mut() {
            // Inside a hunk: any `+++…` here is an ADDED content line whose source
            // begins with `++` (the header form is gated out above by `in_hunk`).
            // Strip the single diff `+` and keep it, advancing `new_line` so later
            // anchors stay aligned.
            if let Some(text) = raw.strip_prefix('+') {
                f.added.push(AddedLine { line: new_line, text: text.to_string() });
                f.added_set.insert(new_line);
                new_line += 1;
            } else if raw.starts_with('-') {
                f.removed_count += 1;
            } else if raw.starts_with('\\') {
                // "\ No newline at end of file" — ignore.
            } else {
                // context line (leading space) — advances the new-file cursor.
                new_line += 1;
            }
        }
    }
    if let Some(f) = cur.take() {
        files.push(f);
    }
    files.retain(|f| !f.path.is_empty());
    files
}

/// Extract the +start from a hunk header `@@ -a,b +c,d @@ section`.
fn parse_hunk_new_start(header: &str) -> Option<u32> {
    let plus = header.split('+').nth(1)?;
    let num: String = plus.chars().take_while(|c| c.is_ascii_digit()).collect();
    num.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "diff --git a/src/api.ts b/src/api.ts\n\
--- a/src/api.ts\n\
+++ b/src/api.ts\n\
@@ -10,3 +10,5 @@ export function getUser(id) {\n\
 const a = 1;\n\
+const token = \"sk-secret\";\n\
+console.log(token);\n\
 return a;\n\
@@ -40,2 +42,2 @@\n\
-old line\n\
+new line\n";

    #[test]
    fn parses_added_lines_with_new_numbers() {
        let files = parse_unified_diff(PATCH);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        assert_eq!(f.path, "src/api.ts");
        // Added at new-file lines 11 and 12 (hunk starts at 10, one context line).
        assert!(f.added_set.contains(&11));
        assert!(f.added_set.contains(&12));
        assert!(f.added_set.contains(&42)); // second hunk replacement
        assert_eq!(f.removed_count, 1); // one "-old line" across both hunks
        assert!(f.added.iter().any(|l| l.text.contains("sk-secret")));
    }

    #[test]
    fn detects_new_file() {
        let p = "diff --git a/new.ts b/new.ts\n\
new file mode 100644\n\
--- /dev/null\n\
+++ b/new.ts\n\
@@ -0,0 +1,2 @@\n\
+export const x = 1;\n\
+export const y = 2;\n";
        let files = parse_unified_diff(p);
        assert_eq!(files.len(), 1);
        assert!(files[0].is_new);
        assert_eq!(files[0].added.len(), 2);
    }

    #[test]
    fn added_line_starting_with_plusplus_is_captured_and_does_not_drift() {
        // Source line `++count;` shows up in the patch as `+++count;`. It must be
        // recorded as an added line, and must still advance the new-file cursor so
        // the following added line keeps its correct number.
        let p = "diff --git a/src/inc.ts b/src/inc.ts\n\
--- a/src/inc.ts\n\
+++ b/src/inc.ts\n\
@@ -10,2 +10,4 @@\n\
 const a = 1;\n\
+++count;\n\
+const b = 2;\n\
 return a;\n";
        let files = parse_unified_diff(p);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        // The `++count;` line is captured at new-file line 11, content intact.
        assert!(
            f.added.iter().any(|l| l.line == 11 && l.text == "++count;"),
            "added `++count;` must be captured at line 11, got {:?}",
            f.added
        );
        // No drift: the next added line is 12, not 11.
        assert!(
            f.added.iter().any(|l| l.line == 12 && l.text == "const b = 2;"),
            "following added line must keep line 12 (no drift), got {:?}",
            f.added
        );
    }

    #[test]
    fn spaced_plusplus_and_minusminus_content_inside_hunk_are_not_headers() {
        // Inside a hunk, `+++ note` (source `++ note`) and `--- drop` (source
        // `-- drop`, e.g. a SQL/Lua comment) are CONTENT, not file headers. They
        // must not corrupt the path or drift later anchors.
        let p = "diff --git a/db/migrate.sql b/db/migrate.sql\n\
--- a/db/migrate.sql\n\
+++ b/db/migrate.sql\n\
@@ -10,3 +10,4 @@\n\
 SELECT 1;\n\
--- drop\n\
+++ note\n\
+SELECT 2;\n";
        let files = parse_unified_diff(p);
        assert_eq!(files.len(), 1);
        let f = &files[0];
        // Path comes from the real `+++ b/...` header, not the `+++ note` content.
        assert_eq!(f.path, "db/migrate.sql");
        // `++ note` is captured as added content at new-file line 11.
        assert!(
            f.added.iter().any(|l| l.line == 11 && l.text == "++ note"),
            "added `++ note` must be captured at line 11, got {:?}",
            f.added
        );
        // No drift: the following added line keeps line 12.
        assert!(
            f.added.iter().any(|l| l.line == 12 && l.text == "SELECT 2;"),
            "following added line must keep line 12 (no drift), got {:?}",
            f.added
        );
        // The `-- drop` removed line is now counted (it was swallowed as a `---`
        // header before the in_hunk gate).
        assert_eq!(f.removed_count, 1);
    }
}
