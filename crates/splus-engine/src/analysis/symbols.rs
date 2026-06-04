//! Symbol + import extraction from tree-sitter ASTs (TS/JS/TSX/Python).
//! Top-level definitions + class methods + import edges — the graph substrate.

use crate::analysis::langspec::{self, LangSpec};
use crate::analysis::tslang;
use crate::collectors::Lang;
use tree_sitter::Node;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Const,
    Variable,
    Interface,
    TypeAlias,
    Enum,
}

impl SymbolKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SymbolKind::Function => "function",
            SymbolKind::Method => "method",
            SymbolKind::Class => "class",
            SymbolKind::Const => "const",
            SymbolKind::Variable => "variable",
            SymbolKind::Interface => "interface",
            SymbolKind::TypeAlias => "type",
            SymbolKind::Enum => "enum",
        }
    }
    /// Symbols worth tracking for blast radius (callable/importable surface).
    pub fn is_impactful(self) -> bool {
        matches!(
            self,
            SymbolKind::Function | SymbolKind::Class | SymbolKind::Const | SymbolKind::Enum
        )
    }
}

#[derive(Debug, Clone)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    pub start_line: u32, // 1-indexed
    pub end_line: u32,
    pub exported: bool,
}

#[derive(Debug, Clone)]
pub struct ImportRef {
    pub names: Vec<String>,
    pub source: String,
}

pub fn extract(lang: Lang, source: &str) -> (Vec<Symbol>, Vec<ImportRef>) {
    let Some(tree) = tslang::parse(lang, source) else {
        return (Vec::new(), Vec::new());
    };
    let root = tree.root_node();
    let bytes = source.as_bytes();
    let mut symbols = Vec::new();
    let mut imports = Vec::new();

    if lang == Lang::Python {
        for i in 0..root.named_child_count() {
            if let Some(c) = root.named_child(i) {
                collect_py(c, bytes, true, &mut symbols, &mut imports);
            }
        }
    } else if lang.is_jsish() {
        for i in 0..root.named_child_count() {
            if let Some(c) = root.named_child(i) {
                collect_js(c, bytes, false, &mut symbols, &mut imports);
            }
        }
    } else if let Some(spec) = langspec::spec(lang) {
        // All other deeply-supported languages share one data-driven collector.
        collect_generic(root, bytes, lang, spec, false, &mut symbols, &mut imports);
    }
    (symbols, imports)
}

fn text<'a>(node: Node, bytes: &'a [u8]) -> &'a str {
    node.utf8_text(bytes).unwrap_or("")
}

fn lines(node: Node) -> (u32, u32) {
    (
        node.start_position().row as u32 + 1,
        node.end_position().row as u32 + 1,
    )
}

fn name_of(node: Node, bytes: &[u8]) -> Option<String> {
    node.child_by_field_name("name")
        .map(|n| text(n, bytes).to_string())
        .filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------

fn collect_js(
    node: Node,
    bytes: &[u8],
    exported: bool,
    symbols: &mut Vec<Symbol>,
    imports: &mut Vec<ImportRef>,
) {
    match node.kind() {
        "import_statement" => {
            if let Some(imp) = parse_js_import(node, bytes) {
                imports.push(imp);
            }
        }
        "export_statement" => {
            // `export <decl>` — recurse into the declaration as exported.
            if let Some(decl) = node.child_by_field_name("declaration") {
                collect_js(decl, bytes, true, symbols, imports);
            } else {
                // `export { a, b }` / `export * from '...'` — recurse children
                // so any inline declaration is still captured.
                for i in 0..node.named_child_count() {
                    if let Some(c) = node.named_child(i) {
                        if c.kind().ends_with("declaration") {
                            collect_js(c, bytes, true, symbols, imports);
                        }
                    }
                }
            }
        }
        "function_declaration" | "generator_function_declaration" => {
            if let Some(name) = name_of(node, bytes) {
                let (s, e) = lines(node);
                symbols.push(Symbol { name, kind: SymbolKind::Function, start_line: s, end_line: e, exported });
            }
        }
        "class_declaration" | "abstract_class_declaration" => {
            if let Some(name) = name_of(node, bytes) {
                let (s, e) = lines(node);
                symbols.push(Symbol { name, kind: SymbolKind::Class, start_line: s, end_line: e, exported });
            }
            if let Some(body) = node.child_by_field_name("body") {
                for i in 0..body.named_child_count() {
                    if let Some(m) = body.named_child(i) {
                        if m.kind() == "method_definition" {
                            if let Some(mn) = name_of(m, bytes) {
                                let (s, e) = lines(m);
                                symbols.push(Symbol { name: mn, kind: SymbolKind::Method, start_line: s, end_line: e, exported: false });
                            }
                        }
                    }
                }
            }
        }
        "lexical_declaration" | "variable_declaration" => {
            let is_const = text(node, bytes).trim_start().starts_with("const");
            for i in 0..node.named_child_count() {
                let Some(decl) = node.named_child(i) else { continue };
                if decl.kind() != "variable_declarator" {
                    continue;
                }
                let Some(name_node) = decl.child_by_field_name("name") else { continue };
                if name_node.kind() != "identifier" {
                    continue; // skip destructuring patterns
                }
                let name = text(name_node, bytes).to_string();
                let value_kind = decl.child_by_field_name("value").map(|v| v.kind());
                let kind = match value_kind {
                    Some("arrow_function") | Some("function") | Some("function_expression")
                    | Some("generator_function") => SymbolKind::Function,
                    _ if is_const => SymbolKind::Const,
                    _ => SymbolKind::Variable,
                };
                let (s, e) = lines(decl);
                symbols.push(Symbol { name, kind, start_line: s, end_line: e, exported });
            }
        }
        "interface_declaration" => push_named(node, bytes, SymbolKind::Interface, exported, symbols),
        "type_alias_declaration" => push_named(node, bytes, SymbolKind::TypeAlias, exported, symbols),
        "enum_declaration" => push_named(node, bytes, SymbolKind::Enum, exported, symbols),
        _ => {}
    }
}

fn push_named(node: Node, bytes: &[u8], kind: SymbolKind, exported: bool, out: &mut Vec<Symbol>) {
    if let Some(name) = name_of(node, bytes) {
        let (s, e) = lines(node);
        out.push(Symbol { name, kind, start_line: s, end_line: e, exported });
    }
}

fn parse_js_import(node: Node, bytes: &[u8]) -> Option<ImportRef> {
    let source = node
        .child_by_field_name("source")
        .map(|n| strip_quotes(text(n, bytes)))?;
    let mut names = Vec::new();
    // Walk the import clause for default/namespace/named import identifiers.
    let mut cursor = node.walk();
    collect_import_names(node, bytes, &mut names, &mut cursor);
    Some(ImportRef { names, source })
}

fn collect_import_names(
    node: Node,
    bytes: &[u8],
    names: &mut Vec<String>,
    _cursor: &mut tree_sitter::TreeCursor,
) {
    for i in 0..node.named_child_count() {
        let Some(c) = node.named_child(i) else { continue };
        match c.kind() {
            "import_specifier" => {
                // Prefer the local alias (field "alias"), else the name.
                let n = c
                    .child_by_field_name("alias")
                    .or_else(|| c.child_by_field_name("name"))
                    .map(|x| text(x, bytes).to_string());
                if let Some(n) = n {
                    names.push(n);
                }
            }
            "identifier" => names.push(text(c, bytes).to_string()),
            "namespace_import" => {
                if let Some(id) = c.named_child(0) {
                    names.push(text(id, bytes).to_string());
                }
            }
            _ => {
                // import_clause / named_imports — recurse.
                if c.named_child_count() > 0 {
                    let mut inner = c.walk();
                    collect_import_names(c, bytes, names, &mut inner);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

fn collect_py(
    node: Node,
    bytes: &[u8],
    top_level: bool,
    symbols: &mut Vec<Symbol>,
    imports: &mut Vec<ImportRef>,
) {
    match node.kind() {
        "function_definition" => {
            if let Some(name) = name_of(node, bytes) {
                let (s, e) = lines(node);
                let exported = top_level && !name.starts_with('_');
                let kind = if top_level { SymbolKind::Function } else { SymbolKind::Method };
                symbols.push(Symbol { name, kind, start_line: s, end_line: e, exported });
            }
        }
        "class_definition" => {
            if let Some(name) = name_of(node, bytes) {
                let (s, e) = lines(node);
                let exported = top_level && !name.starts_with('_');
                symbols.push(Symbol { name, kind: SymbolKind::Class, start_line: s, end_line: e, exported });
            }
            // Methods inside the class body.
            if let Some(body) = node.child_by_field_name("body") {
                for i in 0..body.named_child_count() {
                    if let Some(c) = body.named_child(i) {
                        collect_py(c, bytes, false, symbols, imports);
                    }
                }
            }
        }
        "decorated_definition" => {
            if let Some(def) = node.child_by_field_name("definition") {
                collect_py(def, bytes, top_level, symbols, imports);
            }
        }
        "import_statement" | "import_from_statement" => {
            if let Some(imp) = parse_py_import(node, bytes) {
                imports.push(imp);
            }
        }
        _ => {}
    }
}

fn parse_py_import(node: Node, bytes: &[u8]) -> Option<ImportRef> {
    let source = node
        .child_by_field_name("module_name")
        .map(|n| text(n, bytes).to_string())
        .unwrap_or_default();
    let mut names = Vec::new();
    for i in 0..node.named_child_count() {
        let Some(c) = node.named_child(i) else { continue };
        match c.kind() {
            "dotted_name" => names.push(text(c, bytes).to_string()),
            "aliased_import" => {
                if let Some(alias) = c.child_by_field_name("alias") {
                    names.push(text(alias, bytes).to_string());
                } else if let Some(n) = c.named_child(0) {
                    names.push(text(n, bytes).to_string());
                }
            }
            _ => {}
        }
    }
    Some(ImportRef { names, source })
}

// ---------------------------------------------------------------------------
// Generic, data-driven collector (Go / Rust / Java / C# / C / C++ / PHP / Ruby /
// Kotlin / Swift / Scala / Bash). Walks the tree collecting top-level functions
// and types plus one level of methods inside type bodies. It never descends into
// function bodies, so only the importable/callable top-level surface is recorded
// — the substrate the SCIP blast-radius tier resolves against.
// ---------------------------------------------------------------------------

fn collect_generic(
    node: Node,
    bytes: &[u8],
    lang: Lang,
    spec: &LangSpec,
    in_type: bool,
    symbols: &mut Vec<Symbol>,
    imports: &mut Vec<ImportRef>,
) {
    for i in 0..node.named_child_count() {
        let Some(child) = node.named_child(i) else { continue };
        let k = child.kind();

        if spec.import_kinds.contains(&k) {
            if let Some(imp) = parse_generic_import(child, bytes) {
                imports.push(imp);
            }
            continue;
        }
        if spec.fn_kinds.contains(&k) {
            if let Some(name) = decl_name(child, lang, bytes) {
                let (s, e) = lines(child);
                let kind = if in_type { SymbolKind::Method } else { SymbolKind::Function };
                let is_exp = exported(lang, child, &name, bytes);
                symbols.push(Symbol { name, kind, start_line: s, end_line: e, exported: is_exp });
            }
            continue; // do NOT descend into function bodies
        }
        if spec.class_kinds.contains(&k) {
            if let Some(name) = decl_name(child, lang, bytes) {
                let (s, e) = lines(child);
                let kind = class_symbol_kind(k);
                let is_exp = exported(lang, child, &name, bytes);
                symbols.push(Symbol { name, kind, start_line: s, end_line: e, exported: is_exp });
            }
            // Descend to pick up this type's methods.
            collect_generic(child, bytes, lang, spec, true, symbols, imports);
            continue;
        }
        // Structural node (block / body / namespace / declaration_list / …): descend,
        // preserving whether we're inside a type so methods are labelled correctly.
        collect_generic(child, bytes, lang, spec, in_type, symbols, imports);
    }
}

/// The addressable name of a declaration node. Most grammars expose a `name`
/// field; C/C++ bury it in a `declarator` chain (`function_declarator` →
/// identifier / field_identifier), so we walk that.
pub(crate) fn decl_name(node: Node, lang: Lang, bytes: &[u8]) -> Option<String> {
    if matches!(lang, Lang::C | Lang::Cpp) && node.kind() == "function_definition" {
        return node
            .child_by_field_name("declarator")
            .and_then(|d| c_declarator_name(d, bytes));
    }
    node.child_by_field_name("name")
        .map(|n| text(n, bytes).to_string())
        .filter(|s| !s.is_empty())
}

fn c_declarator_name(node: Node, bytes: &[u8]) -> Option<String> {
    match node.kind() {
        "identifier" | "field_identifier" | "type_identifier" | "operator_name"
        | "destructor_name" | "qualified_identifier" => {
            let t = text(node, bytes);
            (!t.is_empty()).then(|| t.to_string())
        }
        _ => {
            // Unwrap pointer/parenthesized/function declarators by their `declarator`
            // field first, then fall back to scanning children.
            if let Some(inner) = node.child_by_field_name("declarator") {
                if let Some(n) = c_declarator_name(inner, bytes) {
                    return Some(n);
                }
            }
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    if let Some(n) = c_declarator_name(c, bytes) {
                        return Some(n);
                    }
                }
            }
            None
        }
    }
}

fn class_symbol_kind(kind: &str) -> SymbolKind {
    if kind.contains("interface") || kind.contains("protocol") {
        SymbolKind::Interface
    } else if kind.contains("enum") {
        SymbolKind::Enum
    } else {
        // class / struct / trait / object / module / type_spec / union
        SymbolKind::Class
    }
}

/// Whether a declaration is part of the public/importable surface. Conservative
/// and per-language: only `exported` impactful symbols are surfaced by the
/// blast-radius collector, so a false negative just suppresses a finding.
fn exported(lang: Lang, node: Node, name: &str, bytes: &[u8]) -> bool {
    match lang {
        // Go: capitalised identifier == exported.
        Lang::Go => name.chars().next().is_some_and(|c| c.is_uppercase()),
        // Rust: presence of a `pub` visibility modifier.
        Lang::Rust => has_child_kind(node, "visibility_modifier"),
        // Java / C#: an explicit `public` modifier.
        Lang::Java => modifiers_contain(node, "modifiers", "public", bytes),
        Lang::CSharp => has_modifier_word(node, "public", bytes),
        // C/C++: linkable unless file-local (`static`).
        Lang::C | Lang::Cpp => !has_static(node, bytes),
        // Visibility-modifier languages: public unless marked private/protected.
        Lang::Php | Lang::Kotlin | Lang::Swift | Lang::Scala => !has_private_visibility(node, bytes),
        // No usable visibility signal — treat the top-level surface as public.
        Lang::Ruby | Lang::Bash => true,
        _ => true,
    }
}

const PRIVATE_WORDS: &[&str] = &["private", "protected", "fileprivate"];

fn has_child_kind(node: Node, kind: &str) -> bool {
    (0..node.named_child_count())
        .filter_map(|i| node.named_child(i))
        .any(|c| c.kind() == kind)
}

/// True if a direct child of `wrapper_kind` (e.g. Java `modifiers`) contains `word`.
fn modifiers_contain(node: Node, wrapper_kind: &str, word: &str, bytes: &[u8]) -> bool {
    (0..node.named_child_count())
        .filter_map(|i| node.named_child(i))
        .filter(|c| c.kind() == wrapper_kind)
        .any(|c| text(c, bytes).contains(word))
}

/// C#: visibility is a sequence of bare `modifier` children.
fn has_modifier_word(node: Node, word: &str, bytes: &[u8]) -> bool {
    (0..node.named_child_count())
        .filter_map(|i| node.named_child(i))
        .filter(|c| c.kind() == "modifier")
        .any(|c| text(c, bytes) == word)
}

fn has_static(node: Node, bytes: &[u8]) -> bool {
    (0..node.named_child_count())
        .filter_map(|i| node.named_child(i))
        .any(|c| c.kind() == "storage_class_specifier" && text(c, bytes).contains("static"))
}

/// Scan direct children (and a `modifiers` wrapper) for a private/protected marker.
fn has_private_visibility(node: Node, bytes: &[u8]) -> bool {
    for i in 0..node.named_child_count() {
        let Some(c) = node.named_child(i) else { continue };
        match c.kind() {
            "visibility_modifier" | "access_modifier" | "modifiers" | "modifier" => {
                let t = text(c, bytes);
                if PRIVATE_WORDS.iter().any(|w| t.contains(w)) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// Best-effort import record. Unused downstream for non-JS languages (the
/// heuristic graph is JS-only and SCIP brings its own graph), but kept for
/// completeness and tests.
fn parse_generic_import(node: Node, bytes: &[u8]) -> Option<ImportRef> {
    let source = text(node, bytes).lines().next().unwrap_or("").trim().to_string();
    (!source.is_empty()).then(|| ImportRef { names: Vec::new(), source })
}

fn strip_quotes(s: &str) -> String {
    s.trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_ts_exports_and_imports() {
        let src = "import { validateToken } from './auth';\n\
import express from 'express';\n\
export function getUser(id: string) { return id; }\n\
export const PORT = 3000;\n\
const helper = (x) => x * 2;\n\
export class Service { run() {} }\n";
        let (syms, imps) = extract(Lang::TypeScript, src);
        let names: Vec<_> = syms.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"getUser"));
        assert!(names.contains(&"PORT"));
        assert!(names.contains(&"helper"));
        assert!(names.contains(&"Service"));
        assert!(names.contains(&"run")); // method

        let get_user = syms.iter().find(|s| s.name == "getUser").unwrap();
        assert!(get_user.exported);
        assert_eq!(get_user.kind, SymbolKind::Function);
        let helper = syms.iter().find(|s| s.name == "helper").unwrap();
        assert!(!helper.exported);

        let auth = imps.iter().find(|i| i.source == "./auth").unwrap();
        assert!(auth.names.contains(&"validateToken".to_string()));
        assert!(imps.iter().any(|i| i.source == "express"));
    }

    #[test]
    fn extracts_python() {
        let src = "from .auth import validate\n\
def public_fn(x):\n    return x\n\
def _private():\n    return 1\n\
class Svc:\n    def run(self):\n        return 2\n";
        let (syms, imps) = extract(Lang::Python, src);
        let pub_fn = syms.iter().find(|s| s.name == "public_fn").unwrap();
        assert!(pub_fn.exported);
        let priv_fn = syms.iter().find(|s| s.name == "_private").unwrap();
        assert!(!priv_fn.exported);
        assert!(syms.iter().any(|s| s.name == "Svc" && s.kind == SymbolKind::Class));
        assert!(syms.iter().any(|s| s.name == "run" && s.kind == SymbolKind::Method));
        assert!(imps.iter().any(|i| i.names.contains(&"validate".to_string())));
    }

    // ── generic collector: each language finds its top-level surface and gets
    //    the exported/visibility flag right ───────────────────────────────────

    fn syms(lang: Lang, src: &str) -> Vec<Symbol> {
        extract(lang, src).0
    }
    fn find<'a>(syms: &'a [Symbol], name: &str) -> &'a Symbol {
        syms.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("symbol {name} not found"))
    }

    #[test]
    fn extracts_go() {
        let s = syms(
            Lang::Go,
            "package m\nfunc Exported() int { return 1 }\nfunc private() {}\ntype Svc struct{}\n",
        );
        assert!(find(&s, "Exported").exported);
        assert!(!find(&s, "private").exported);
        assert_eq!(find(&s, "Svc").kind, SymbolKind::Class);
    }

    #[test]
    fn extracts_rust() {
        let s = syms(
            Lang::Rust,
            "pub fn exported() -> i32 { 1 }\nfn private_fn() {}\nstruct Svc;\nimpl Svc { pub fn run(&self) -> i32 { 1 } }\nenum E { A }\n",
        );
        assert!(find(&s, "exported").exported);
        assert!(!find(&s, "private_fn").exported);
        assert!(find(&s, "run").exported); // pub impl method
        assert!(!find(&s, "Svc").exported); // no `pub`
        assert_eq!(find(&s, "E").kind, SymbolKind::Enum);
    }

    #[test]
    fn extracts_java() {
        let s = syms(
            Lang::Java,
            "public class Svc {\n  public int run(int a) { return a; }\n  private void helper() {}\n}\ninterface I { void m(); }\n",
        );
        assert!(find(&s, "Svc").exported);
        assert_eq!(find(&s, "Svc").kind, SymbolKind::Class);
        assert!(find(&s, "run").exported);
        assert!(!find(&s, "helper").exported);
        assert_eq!(find(&s, "I").kind, SymbolKind::Interface);
    }

    #[test]
    fn extracts_csharp() {
        let s = syms(
            Lang::CSharp,
            "namespace N { public class Svc { public int Run() { return 1; } private void Helper() {} } }\n",
        );
        assert!(find(&s, "Svc").exported);
        assert!(find(&s, "Run").exported);
        assert!(!find(&s, "Helper").exported);
    }

    #[test]
    fn extracts_c() {
        let s = syms(
            Lang::C,
            "int exported(int a) { return a; }\nstatic int helper(void) { return 1; }\nstruct P { int x; };\n",
        );
        assert!(find(&s, "exported").exported);
        assert!(!find(&s, "helper").exported); // static == file-local
        assert_eq!(find(&s, "P").kind, SymbolKind::Class);
    }

    #[test]
    fn extracts_cpp() {
        let s = syms(
            Lang::Cpp,
            "namespace n { class Svc { public: int run(int a) { return a; } }; }\nint freefn(int a) { return a; }\n",
        );
        assert!(find(&s, "freefn").exported);
        assert_eq!(find(&s, "Svc").kind, SymbolKind::Class);
        assert!(s.iter().any(|x| x.name == "run")); // method name pulled from declarator
    }

    #[test]
    fn extracts_php() {
        let s = syms(
            Lang::Php,
            "<?php\nclass Svc {\n  public function run($a) { return $a; }\n  private function helper() {}\n}\nfunction freefn($a) { return $a; }\n",
        );
        assert!(find(&s, "freefn").exported);
        assert!(find(&s, "run").exported);
        assert!(!find(&s, "helper").exported);
    }

    #[test]
    fn extracts_ruby() {
        let s = syms(
            Lang::Ruby,
            "class Svc\n  def run(a); a; end\nend\nmodule M\nend\ndef freefn(a); a; end\n",
        );
        assert!(find(&s, "freefn").exported);
        assert_eq!(find(&s, "Svc").kind, SymbolKind::Class);
        assert!(s.iter().any(|x| x.name == "run"));
    }

    #[test]
    fn extracts_kotlin() {
        let s = syms(
            Lang::Kotlin,
            "class Svc {\n  fun run(a: Int): Int { return a }\n  private fun helper() {}\n}\nfun freefn(a: Int) = a\n",
        );
        assert!(find(&s, "freefn").exported);
        assert!(!find(&s, "helper").exported);
        assert_eq!(find(&s, "Svc").kind, SymbolKind::Class);
    }

    #[test]
    fn extracts_swift() {
        let s = syms(
            Lang::Swift,
            "class Svc {\n  func run(_ a: Int) -> Int { return a }\n  private func helper() {}\n}\nfunc freefn(_ a: Int) -> Int { return a }\n",
        );
        assert!(find(&s, "freefn").exported);
        assert!(!find(&s, "helper").exported);
    }

    #[test]
    fn extracts_scala() {
        let s = syms(
            Lang::Scala,
            "class Svc {\n  def run(a: Int): Int = a\n  private def helper(): Int = 1\n}\nobject O { def m(): Int = 1 }\n",
        );
        assert!(find(&s, "run").exported);
        assert!(!find(&s, "helper").exported);
        assert_eq!(find(&s, "Svc").kind, SymbolKind::Class);
    }

    #[test]
    fn extracts_bash() {
        let s = syms(Lang::Bash, "run() {\n  echo hi\n}\ndeploy() {\n  echo go\n}\n");
        assert!(find(&s, "run").exported);
        assert_eq!(find(&s, "deploy").kind, SymbolKind::Function);
    }
}
