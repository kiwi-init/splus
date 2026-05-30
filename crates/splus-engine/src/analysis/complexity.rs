//! Cognitive Complexity (Sonar-style): increments on every break in linear
//! control flow, plus an extra penalty equal to the current nesting depth.
//! A faithful, deterministic approximation — better than cyclomatic as a
//! "review-worthiness" signal because it punishes nesting.

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

#[derive(Clone, Copy, PartialEq)]
enum Fam {
    Js,
    Py,
}

fn fam(lang: Lang) -> Fam {
    if lang == Lang::Python {
        Fam::Py
    } else {
        Fam::Js
    }
}

/// Compute cognitive complexity for every named/addressable function in `source`.
pub fn function_complexities(lang: Lang, source: &str) -> Vec<FnComplexity> {
    let Some(tree) = tslang::parse(lang, source) else {
        return Vec::new();
    };
    let bytes = source.as_bytes();
    let f = fam(lang);
    let mut out = Vec::new();
    collect_fns(tree.root_node(), bytes, f, &mut out);
    out
}

fn text<'a>(node: Node, bytes: &'a [u8]) -> &'a str {
    node.utf8_text(bytes).unwrap_or("")
}

fn collect_fns(node: Node, bytes: &[u8], f: Fam, out: &mut Vec<FnComplexity>) {
    if let Some((name, fnode)) = named_function(node, bytes, f) {
        let body = fnode.child_by_field_name("body").unwrap_or(fnode);
        let mut score = 0u32;
        for i in 0..body.named_child_count() {
            if let Some(c) = body.named_child(i) {
                walk_cc(c, bytes, f, 0, &mut score);
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
            collect_fns(c, bytes, f, out);
        }
    }
}

/// Returns (name, function_node) if `node` is a named/addressable function.
fn named_function<'a>(node: Node<'a>, bytes: &[u8], f: Fam) -> Option<(String, Node<'a>)> {
    match f {
        Fam::Js => match node.kind() {
            "function_declaration" | "generator_function_declaration" | "method_definition" => {
                let name = node.child_by_field_name("name").map(|n| text(n, bytes).to_string())?;
                Some((name, node))
            }
            "variable_declarator" => {
                let value = node.child_by_field_name("value")?;
                if matches!(
                    value.kind(),
                    "arrow_function" | "function" | "function_expression" | "generator_function"
                ) {
                    let name = node.child_by_field_name("name").map(|n| text(n, bytes).to_string())?;
                    Some((name, value))
                } else {
                    None
                }
            }
            _ => None,
        },
        Fam::Py => {
            if node.kind() == "function_definition" {
                let name = node.child_by_field_name("name").map(|n| text(n, bytes).to_string())?;
                Some((name, node))
            } else {
                None
            }
        }
    }
}

fn walk_cc(node: Node, bytes: &[u8], f: Fam, depth: u32, score: &mut u32) {
    let kind = node.kind();
    let mut child_depth = depth;

    if is_nest_inc(kind, f) {
        *score += 1 + depth;
        child_depth = depth + 1;
    } else if is_flat(kind, f) {
        *score += 1;
    } else if is_logical(node, bytes, f) {
        *score += 1;
    } else if is_nested_fn(kind, f) {
        child_depth = depth + 1;
    }

    for i in 0..node.named_child_count() {
        if let Some(c) = node.named_child(i) {
            walk_cc(c, bytes, f, child_depth, score);
        }
    }
}

fn is_nest_inc(kind: &str, f: Fam) -> bool {
    match f {
        Fam::Js => matches!(
            kind,
            "if_statement"
                | "for_statement"
                | "for_in_statement"
                | "while_statement"
                | "do_statement"
                | "switch_statement"
                | "catch_clause"
                | "ternary_expression"
                | "conditional_expression"
        ),
        Fam::Py => matches!(
            kind,
            "if_statement"
                | "for_statement"
                | "while_statement"
                | "except_clause"
                | "conditional_expression"
        ),
    }
}

fn is_flat(kind: &str, f: Fam) -> bool {
    match f {
        // else-if chains: tree-sitter-js nests them as if_statement under
        // `alternative`, so they're already handled by is_nest_inc.
        Fam::Js => false,
        Fam::Py => matches!(kind, "elif_clause"),
    }
}

fn is_logical(node: Node, bytes: &[u8], f: Fam) -> bool {
    match f {
        Fam::Js => {
            node.kind() == "binary_expression"
                && node
                    .child_by_field_name("operator")
                    .map(|o| {
                        let t = text(o, bytes);
                        t == "&&" || t == "||" || t == "??"
                    })
                    .unwrap_or(false)
        }
        Fam::Py => node.kind() == "boolean_operator",
    }
}

fn is_nested_fn(kind: &str, f: Fam) -> bool {
    match f {
        Fam::Js => matches!(
            kind,
            "function_declaration"
                | "function_expression"
                | "function"
                | "arrow_function"
                | "generator_function"
                | "method_definition"
        ),
        Fam::Py => matches!(kind, "function_definition" | "lambda"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_function_is_low() {
        let fns = function_complexities(Lang::TypeScript, "function f(x){ return x + 1; }");
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].score, 0);
    }

    #[test]
    fn nesting_is_penalized() {
        // if(+1) > for(+2: 1+nest) > if(+3: 1+nest2) = 6, plus a logical &&.
        let src = "function f(a,b,c){\n\
  if (a) {\n\
    for (let i=0;i<10;i++){\n\
      if (b && c) { return 1; }\n\
    }\n\
  }\n\
}";
        let fns = function_complexities(Lang::JavaScript, src);
        let f = fns.iter().find(|x| x.name == "f").unwrap();
        // if=1, for=2, inner if=3, &&=1  => 7
        assert!(f.score >= 6, "expected >=6 got {}", f.score);
    }

    #[test]
    fn python_function() {
        // NB: no `\` line-continuation here — it would strip Python's
        // significant indentation and produce invalid source.
        let src = "def f(a, b):\n    if a:\n        for x in b:\n            if x and a:\n                return x\n";
        let fns = function_complexities(Lang::Python, src);
        let f = fns.iter().find(|x| x.name == "f").unwrap();
        assert!(f.score >= 6, "got {}", f.score);
    }
}
