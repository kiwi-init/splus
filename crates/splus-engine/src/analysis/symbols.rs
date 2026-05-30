//! Symbol + import extraction from tree-sitter ASTs (TS/JS/TSX/Python).
//! Top-level definitions + class methods + import edges — the graph substrate.

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
    } else {
        for i in 0..root.named_child_count() {
            if let Some(c) = root.named_child(i) {
                collect_js(c, bytes, false, &mut symbols, &mut imports);
            }
        }
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
}
