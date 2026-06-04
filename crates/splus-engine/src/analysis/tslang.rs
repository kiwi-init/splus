//! Tree-sitter language registry + parsing for the analysis tier.
//! Precise-tier languages first (TS/JS/TSX/Python); others degrade gracefully.

use crate::collectors::Lang;
use tree_sitter::{Language, Parser, Tree};

/// Map our Lang to a tree-sitter Language, if we have a grammar for it.
pub fn ts_language(lang: Lang) -> Option<Language> {
    match lang {
        Lang::TypeScript => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        Lang::Tsx => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        Lang::JavaScript | Lang::Jsx => Some(tree_sitter_javascript::LANGUAGE.into()),
        Lang::Python => Some(tree_sitter_python::LANGUAGE.into()),
        Lang::Go => Some(tree_sitter_go::LANGUAGE.into()),
        Lang::Rust => Some(tree_sitter_rust::LANGUAGE.into()),
        Lang::Java => Some(tree_sitter_java::LANGUAGE.into()),
        Lang::CSharp => Some(tree_sitter_c_sharp::LANGUAGE.into()),
        Lang::Cpp => Some(tree_sitter_cpp::LANGUAGE.into()),
        Lang::C => Some(tree_sitter_c::LANGUAGE.into()),
        Lang::Php => Some(tree_sitter_php::LANGUAGE_PHP.into()),
        Lang::Ruby => Some(tree_sitter_ruby::LANGUAGE.into()),
        Lang::Kotlin => Some(tree_sitter_kotlin_ng::LANGUAGE.into()),
        Lang::Swift => Some(tree_sitter_swift::LANGUAGE.into()),
        Lang::Scala => Some(tree_sitter_scala::LANGUAGE.into()),
        Lang::Bash => Some(tree_sitter_bash::LANGUAGE.into()),
        Lang::Other => None,
    }
}

/// True if we deeply analyze this language (symbols/complexity/graph).
pub fn is_supported(lang: Lang) -> bool {
    ts_language(lang).is_some()
}

/// Parse source into a tree-sitter Tree, or None if unsupported/failed.
pub fn parse(lang: Lang, source: &str) -> Option<Tree> {
    let language = ts_language(lang)?;
    let mut parser = Parser::new();
    parser.set_language(&language).ok()?;
    parser.parse(source, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typescript() {
        let tree = parse(Lang::TypeScript, "export function f(x: number) { return x + 1; }");
        assert!(tree.is_some());
        let t = tree.unwrap();
        assert_eq!(t.root_node().kind(), "program");
        assert!(!t.root_node().has_error());
    }

    #[test]
    fn parses_python() {
        let tree = parse(Lang::Python, "def f(x):\n    return x + 1\n");
        assert!(tree.is_some());
        assert_eq!(tree.unwrap().root_node().kind(), "module");
    }
}
