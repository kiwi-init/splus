//! Cognitive Complexity (Sonar-style): increments on every break in linear
//! control flow, plus an extra penalty equal to the current nesting depth.
//! A faithful, deterministic approximation — better than cyclomatic as a
//! "review-worthiness" signal because it punishes nesting.
//!
//! The control-flow vocabulary is data-driven per language via `LangSpec`, so
//! all 15 deeply-supported languages share this one walker.

use crate::analysis::langspec::{self, LangSpec};
use crate::analysis::symbols::decl_name;
use crate::analysis::tslang;
use crate::collectors::Lang;
use tree_sitter::Node;

#[derive(Debug, Clone)]
pub struct FnComplexity {
    pub name: String,
    pub start_line: u32,
    pub end_line: u32,
    pub score: u32,
}

/// Compute cognitive complexity for every named/addressable function in `source`.
pub fn function_complexities(lang: Lang, source: &str) -> Vec<FnComplexity> {
    let (Some(tree), Some(spec)) = (tslang::parse(lang, source), langspec::spec(lang)) else {
        return Vec::new();
    };
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    collect_fns(tree.root_node(), bytes, lang, spec, &mut out);
    out
}

fn text<'a>(node: Node, bytes: &'a [u8]) -> &'a str {
    node.utf8_text(bytes).unwrap_or("")
}

fn collect_fns(node: Node, bytes: &[u8], lang: Lang, spec: &LangSpec, out: &mut Vec<FnComplexity>) {
    if let Some((name, fnode)) = named_function(node, lang, spec, bytes) {
        let body = fnode.child_by_field_name("body").unwrap_or(fnode);
        let mut score = 0u32;
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                walk_cc(c, bytes, spec, 0, &mut score);
            }
        }
        out.push(FnComplexity {
            name,
            start_line: node.start_position().row as u32 + 1,
            end_line: node.end_position().row as u32 + 1,
            score,
        });
    }
    for i in 0..node.named_child_count() {
        if let Some(c) = node.named_child(i) {
            collect_fns(c, bytes, lang, spec, out);
        }
    }
}

/// Returns (name, function_node) if `node` is a named/addressable function.
fn named_function<'a>(
    node: Node<'a>,
    lang: Lang,
    spec: &LangSpec,
    bytes: &[u8],
) -> Option<(String, Node<'a>)> {
    // JS/TS: `const f = () => …` / `const f = function …` — the addressable name
    // is on the declarator, but control flow lives in the value expression.
    if lang.is_jsish() && node.kind() == "variable_declarator" {
        let value = node.child_by_field_name("value")?;
        if matches!(
            value.kind(),
            "arrow_function" | "function" | "function_expression" | "generator_function"
        ) {
            let name = node.child_by_field_name("name").map(|n| text(n, bytes).to_string())?;
            return Some((name, value));
        }
        return None;
    }
    if spec.fn_kinds.contains(&node.kind()) {
        let name = decl_name(node, lang, bytes)?;
        return Some((name, node));
    }
    None
}

fn walk_cc(node: Node, bytes: &[u8], spec: &LangSpec, depth: u32, score: &mut u32) {
    let kind = node.kind();
    let mut child_depth = depth;

    if spec.nest_inc.contains(&kind) {
        *score += 1 + depth;
        child_depth = depth + 1;
    } else if spec.flat_inc.contains(&kind) {
        *score += 1;
    } else if is_logical(node, spec, bytes) {
        *score += 1;
    } else if spec.nested_fn.contains(&kind) {
        child_depth = depth + 1;
    }

    for i in 0..node.named_child_count() {
        if let Some(c) = node.named_child(i) {
            walk_cc(c, bytes, spec, child_depth, score);
        }
    }
}

/// A short-circuit boolean combination. For grammars with a dedicated node kind
/// (`boolean_operator`, `conjunction_expression`, bash `list`) `logical_ops` is
/// empty and the kind alone counts; otherwise the operator token must match so
/// that arithmetic/comparison `binary_expression`s don't trip it.
fn is_logical(node: Node, spec: &LangSpec, bytes: &[u8]) -> bool {
    if !spec.logical_kind.contains(&node.kind()) {
        return false;
    }
    if spec.logical_ops.is_empty() {
        return true;
    }
    if let Some(op) = node.child_by_field_name("operator") {
        return spec.logical_ops.contains(&text(op, bytes));
    }
    let mut c = node.walk();
    for child in node.children(&mut c) {
        if spec.logical_ops.contains(&child.kind()) || spec.logical_ops.contains(&text(child, bytes)) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score_of(lang: Lang, src: &str, name: &str) -> u32 {
        function_complexities(lang, src)
            .into_iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("function {name} not found"))
            .score
    }

    #[test]
    fn simple_function_is_low() {
        let fns = function_complexities(Lang::TypeScript, "function f(x){ return x + 1; }");
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].score, 0);
    }

    #[test]
    fn nesting_is_penalized() {
        let src = "function f(a,b,c){\n\
  if (a) {\n\
    for (let i=0;i<10;i++){\n\
      if (b && c) { return 1; }\n\
    }\n\
  }\n\
}";
        // if=1, for=2, inner if=3, &&=1  => 7
        assert!(score_of(Lang::JavaScript, src, "f") >= 6);
    }

    #[test]
    fn python_function() {
        let src = "def f(a, b):\n    if a:\n        for x in b:\n            if x and a:\n                return x\n";
        assert!(score_of(Lang::Python, src, "f") >= 6);
    }

    // ── new languages: a nested if/loop/branch + a logical op should score high ──

    #[test]
    fn go_complexity() {
        let src = "package m\nfunc F(a int, b int) int {\n\tif a > 0 && b > 0 {\n\t\tfor i := 0; i < a; i++ {\n\t\t\tif b > i { return 1 }\n\t\t}\n\t}\n\treturn 0\n}\n";
        assert!(score_of(Lang::Go, src, "F") >= 6, "go score too low");
    }

    #[test]
    fn rust_complexity() {
        let src = "pub fn f(a: i32, b: i32) -> i32 {\n    if a > 0 && b > 0 {\n        for i in 0..a { if b > i { return 1; } }\n    }\n    0\n}\n";
        assert!(score_of(Lang::Rust, src, "f") >= 6, "rust score too low");
    }

    #[test]
    fn java_complexity() {
        let src = "class C {\n  int f(int a, int b) {\n    if (a > 0 && b > 0) { for (int i=0;i<a;i++){ if (b>i) return 1; } }\n    return 0;\n  }\n}\n";
        assert!(score_of(Lang::Java, src, "f") >= 6, "java score too low");
    }

    #[test]
    fn csharp_complexity() {
        let src = "class C {\n  int F(int a, int b) {\n    if (a > 0 && b > 0) { for (int i=0;i<a;i++){ if (b>i) return 1; } }\n    return 0;\n  }\n}\n";
        assert!(score_of(Lang::CSharp, src, "F") >= 6, "c# score too low");
    }

    #[test]
    fn cpp_complexity() {
        let src = "int f(int a, int b) {\n  if (a > 0 && b > 0) { for (int i=0;i<a;i++){ if (b>i) return 1; } }\n  return 0;\n}\n";
        assert!(score_of(Lang::Cpp, src, "f") >= 6, "cpp score too low");
    }

    #[test]
    fn c_complexity() {
        let src = "int f(int a, int b) {\n  if (a > 0 && b > 0) { for (int i=0;i<a;i++){ if (b>i) return 1; } }\n  return 0;\n}\n";
        assert!(score_of(Lang::C, src, "f") >= 6, "c score too low");
    }

    #[test]
    fn php_complexity() {
        let src = "<?php\nfunction f($a, $b) {\n  if ($a > 0 && $b > 0) { foreach ([1] as $i) { if ($b > $i) return 1; } }\n  return 0;\n}\n";
        assert!(score_of(Lang::Php, src, "f") >= 6, "php score too low");
    }

    #[test]
    fn ruby_complexity() {
        let src = "def f(a, b)\n  if a > 0 && b > 0\n    for i in 1..a do\n      return 1 if b > i\n    end\n  end\n  0\nend\n";
        assert!(score_of(Lang::Ruby, src, "f") >= 4, "ruby score too low");
    }

    #[test]
    fn kotlin_complexity() {
        let src = "fun f(a: Int, b: Int): Int {\n  if (a > 0 && b > 0) { for (i in 0..a) { if (b > i) return 1 } }\n  return 0\n}\n";
        assert!(score_of(Lang::Kotlin, src, "f") >= 6, "kotlin score too low");
    }

    #[test]
    fn swift_complexity() {
        let src = "func f(_ a: Int, _ b: Int) -> Int {\n  if a > 0 && b > 0 { for i in 0..<a { if b > i { return 1 } } }\n  return 0\n}\n";
        assert!(score_of(Lang::Swift, src, "f") >= 6, "swift score too low");
    }

    #[test]
    fn scala_complexity() {
        let src = "object O {\n  def f(a: Int, b: Int): Int = {\n    if (a > 0 && b > 0) { for (i <- 0 to a) { if (b > i) return 1 } }\n    0\n  }\n}\n";
        assert!(score_of(Lang::Scala, src, "f") >= 6, "scala score too low");
    }

    #[test]
    fn bash_complexity() {
        let src = "f() {\n  if [ \"$1\" -gt 0 ] && [ \"$2\" -gt 0 ]; then\n    for i in 1 2 3; do\n      if [ \"$2\" -gt \"$i\" ]; then return 1; fi\n    done\n  fi\n  return 0\n}\n";
        assert!(score_of(Lang::Bash, src, "f") >= 5, "bash score too low");
    }
}
