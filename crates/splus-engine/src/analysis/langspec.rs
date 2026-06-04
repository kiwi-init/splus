//! Per-language tree-sitter node-kind vocabulary. One data table drives the
//! generic complexity walker and the generic symbol collector, so adding a
//! language is "fill in the node names" rather than "write another match arm".
//!
//! Every node-kind string below was verified against the real grammar's
//! s-expression output; the unit tests in `complexity.rs` / `symbols.rs` are the
//! regression guard (a wrong name silently yields an empty result, which a test
//! catches). JS and Python keep their bespoke collectors in `symbols.rs`, but
//! still use a spec here for complexity.

use crate::collectors::Lang;

/// The tree-sitter node-kind vocabulary for one language.
pub struct LangSpec {
    // ── cognitive complexity ────────────────────────────────────────────────
    /// Structures that increment by `1 + depth` AND increase nesting depth
    /// (if / loops / switch / catch / ternary …).
    pub nest_inc: &'static [&'static str],
    /// Structures that increment by a flat `1` without adding nesting
    /// (e.g. Python `elif`) — used when the grammar does not nest them under the
    /// parent conditional.
    pub flat_inc: &'static [&'static str],
    /// Node kinds that represent a boolean combination. If `logical_ops` is
    /// non-empty the operator token must match (so `a > b` doesn't count); if
    /// empty the node kind is dedicated (e.g. `conjunction_expression`) and
    /// always counts.
    pub logical_kind: &'static [&'static str],
    /// Operator tokens counted as a logical-sequence increment.
    pub logical_ops: &'static [&'static str],
    /// Function-like nodes that bump nesting depth when entered (closures etc.).
    pub nested_fn: &'static [&'static str],

    // ── symbols (used by the generic collector) ─────────────────────────────
    /// Function / constructor / method declaration node kinds.
    pub fn_kinds: &'static [&'static str],
    /// Type-defining node kinds (class/struct/enum/interface/trait/module …).
    pub class_kinds: &'static [&'static str],
    /// Import/use/include statement node kinds.
    pub import_kinds: &'static [&'static str],
}

/// `&&` / `||` — the C-family short-circuit operators.
const C_LOGICAL_OPS: &[&str] = &["&&", "||"];

/// The spec for a language, if we deeply analyze it. `None` = secrets+heuristics
/// only.
pub fn spec(lang: Lang) -> Option<&'static LangSpec> {
    let s: &'static LangSpec = match lang {
        Lang::TypeScript | Lang::JavaScript | Lang::Tsx | Lang::Jsx => &JS,
        Lang::Python => &PY,
        Lang::Go => &GO,
        Lang::Rust => &RUST,
        Lang::Java => &JAVA,
        Lang::CSharp => &CSHARP,
        Lang::Cpp => &CPP,
        Lang::C => &C,
        Lang::Php => &PHP,
        Lang::Ruby => &RUBY,
        Lang::Kotlin => &KOTLIN,
        Lang::Swift => &SWIFT,
        Lang::Scala => &SCALA,
        Lang::Bash => &BASH,
        Lang::Other => return None,
    };
    Some(s)
}

// ── JavaScript / TypeScript ─────────────────────────────────────────────────
// Reproduces the node lists the previous hardcoded `Fam::Js` used, so existing
// complexity tests stay green. else-if chains nest under `alternative` as
// `if_statement`, already covered by `nest_inc`. JS/TS use the bespoke
// `collect_js` for symbols, so `fn_kinds`/`class_kinds` here are unused by them.
static JS: LangSpec = LangSpec {
    nest_inc: &[
        "if_statement",
        "for_statement",
        "for_in_statement",
        "while_statement",
        "do_statement",
        "switch_statement",
        "catch_clause",
        "ternary_expression",
        "conditional_expression",
    ],
    flat_inc: &[],
    logical_kind: &["binary_expression"],
    logical_ops: &["&&", "||", "??"],
    nested_fn: &[
        "function_declaration",
        "function_expression",
        "function",
        "arrow_function",
        "generator_function",
        "method_definition",
    ],
    fn_kinds: &["function_declaration", "generator_function_declaration", "method_definition"],
    class_kinds: &["class_declaration", "abstract_class_declaration"],
    import_kinds: &["import_statement"],
};

// ── Python ───────────────────────────────────────────────────────────────────
static PY: LangSpec = LangSpec {
    nest_inc: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "except_clause",
        "conditional_expression",
    ],
    flat_inc: &["elif_clause"],
    logical_kind: &["boolean_operator"], // dedicated and/or node — always counts
    logical_ops: &[],
    nested_fn: &["function_definition", "lambda"],
    fn_kinds: &["function_definition"],
    class_kinds: &["class_definition"],
    import_kinds: &["import_statement", "import_from_statement"],
};

// ── Go ───────────────────────────────────────────────────────────────────────
// type name lives on the inner `type_spec`; methods are top-level
// `method_declaration` (counted as functions for impact).
static GO: LangSpec = LangSpec {
    nest_inc: &[
        "if_statement",
        "for_statement",
        "expression_switch_statement",
        "type_switch_statement",
        "select_statement",
    ],
    flat_inc: &[],
    logical_kind: &["binary_expression"],
    logical_ops: C_LOGICAL_OPS,
    nested_fn: &["func_literal"],
    fn_kinds: &["function_declaration", "method_declaration"],
    class_kinds: &["type_spec"],
    import_kinds: &["import_declaration"],
};

// ── Rust ───────────────────────────────────────────────────────────────────── (impl methods surface as functions)
static RUST: LangSpec = LangSpec {
    nest_inc: &[
        "if_expression",
        "while_expression",
        "for_expression",
        "loop_expression",
        "match_expression",
    ],
    flat_inc: &[],
    logical_kind: &["binary_expression"],
    logical_ops: C_LOGICAL_OPS,
    nested_fn: &["closure_expression"],
    fn_kinds: &["function_item"],
    class_kinds: &["struct_item", "enum_item", "trait_item", "union_item", "mod_item"],
    import_kinds: &["use_declaration"],
};

// ── Java ───────────────────────────────────────────────────────────────────────
static JAVA: LangSpec = LangSpec {
    nest_inc: &[
        "if_statement",
        "for_statement",
        "enhanced_for_statement",
        "while_statement",
        "do_statement",
        "switch_expression",
        "catch_clause",
        "ternary_expression",
    ],
    flat_inc: &[],
    logical_kind: &["binary_expression"],
    logical_ops: C_LOGICAL_OPS,
    nested_fn: &["lambda_expression"],
    fn_kinds: &["method_declaration", "constructor_declaration"],
    class_kinds: &[
        "class_declaration",
        "interface_declaration",
        "enum_declaration",
        "record_declaration",
        "annotation_type_declaration",
    ],
    import_kinds: &["import_declaration"],
};

// ── C# ─────────────────────────────────────────────────────────────────────── (foreach_statement, not for_each)
static CSHARP: LangSpec = LangSpec {
    nest_inc: &[
        "if_statement",
        "for_statement",
        "foreach_statement",
        "while_statement",
        "do_statement",
        "switch_statement",
        "switch_expression",
        "catch_clause",
        "conditional_expression",
    ],
    flat_inc: &[],
    logical_kind: &["binary_expression"],
    logical_ops: C_LOGICAL_OPS,
    nested_fn: &["lambda_expression", "local_function_statement"],
    fn_kinds: &["method_declaration", "constructor_declaration", "local_function_statement"],
    class_kinds: &[
        "class_declaration",
        "struct_declaration",
        "interface_declaration",
        "enum_declaration",
        "record_declaration",
    ],
    import_kinds: &["using_directive"],
};

// ── C++ ────────────────────────────────────────────────────────────────────── (fn name nested in declarator)
static CPP: LangSpec = LangSpec {
    nest_inc: &[
        "if_statement",
        "for_statement",
        "for_range_loop",
        "while_statement",
        "do_statement",
        "switch_statement",
        "catch_clause",
        "conditional_expression",
    ],
    flat_inc: &[],
    logical_kind: &["binary_expression"],
    logical_ops: C_LOGICAL_OPS,
    nested_fn: &["lambda_expression"],
    fn_kinds: &["function_definition"],
    class_kinds: &["class_specifier", "struct_specifier", "enum_specifier"],
    import_kinds: &["preproc_include"],
};

// ── C ─────────────────────────────────────────────────────────────────────────
static C: LangSpec = LangSpec {
    nest_inc: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "do_statement",
        "switch_statement",
        "conditional_expression",
    ],
    flat_inc: &[],
    logical_kind: &["binary_expression"],
    logical_ops: C_LOGICAL_OPS,
    nested_fn: &[],
    fn_kinds: &["function_definition"],
    class_kinds: &["struct_specifier", "enum_specifier", "union_specifier"],
    import_kinds: &["preproc_include"],
};

// ── PHP ─────────────────────────────────────────────────────────────────────── (names are `name` nodes)
static PHP: LangSpec = LangSpec {
    nest_inc: &[
        "if_statement",
        "for_statement",
        "foreach_statement",
        "while_statement",
        "do_statement",
        "switch_statement",
        "catch_clause",
        "conditional_expression",
    ],
    flat_inc: &[],
    logical_kind: &["binary_expression"],
    logical_ops: &["&&", "||", "and", "or"],
    nested_fn: &["anonymous_function_creation_expression", "arrow_function"],
    fn_kinds: &["function_definition", "method_declaration"],
    class_kinds: &["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration"],
    import_kinds: &["namespace_use_declaration"],
};

// ── Ruby ─────────────────────────────────────────────────────────────────────── (node kinds are short: `if`, `case`, `binary`)
static RUBY: LangSpec = LangSpec {
    nest_inc: &["if", "unless", "while", "until", "for", "case", "rescue", "conditional"],
    flat_inc: &["elsif"],
    logical_kind: &["binary"],
    logical_ops: &["&&", "||", "and", "or"],
    nested_fn: &["block", "do_block", "lambda"],
    fn_kinds: &["method", "singleton_method"],
    class_kinds: &["class", "module"],
    import_kinds: &[],
};

// ── Kotlin (tree-sitter-kotlin-ng) ─────────────────────────────────────────── (&& is binary_expression; import is `import`)
static KOTLIN: LangSpec = LangSpec {
    nest_inc: &[
        "if_expression",
        "for_statement",
        "while_statement",
        "do_while_statement",
        "when_expression",
        "catch_block",
    ],
    flat_inc: &[],
    logical_kind: &["binary_expression"],
    logical_ops: &["&&", "||"],
    nested_fn: &["lambda_literal", "anonymous_function"],
    fn_kinds: &["function_declaration"],
    class_kinds: &["class_declaration", "object_declaration"],
    import_kinds: &["import"],
};

// ── Swift ─────────────────────────────────────────────────────────────────────  (&&/|| are dedicated conjunction/disjunction)
static SWIFT: LangSpec = LangSpec {
    nest_inc: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "guard_statement",
        "switch_statement",
        "catch_block",
    ],
    flat_inc: &[],
    logical_kind: &["conjunction_expression", "disjunction_expression"],
    logical_ops: &[],
    nested_fn: &["lambda_literal"],
    fn_kinds: &["function_declaration", "init_declaration", "protocol_function_declaration"],
    class_kinds: &["class_declaration", "protocol_declaration", "struct_declaration", "enum_declaration"],
    import_kinds: &["import_declaration"],
};

// ── Scala ─────────────────────────────────────────────────────────────────────  (infix_expression w/ named operator_identifier)
static SCALA: LangSpec = LangSpec {
    nest_inc: &["if_expression", "for_expression", "while_expression", "match_expression", "catch_clause"],
    flat_inc: &[],
    logical_kind: &["infix_expression"],
    logical_ops: &["&&", "||"],
    nested_fn: &["lambda_expression"],
    fn_kinds: &["function_definition", "function_declaration"],
    class_kinds: &["class_definition", "object_definition", "trait_definition", "enum_definition"],
    import_kinds: &["import_declaration"],
};

// ── Bash ─────────────────────────────────────────────────────────────────────── (`cmd && cmd` is a `list` node)
static BASH: LangSpec = LangSpec {
    nest_inc: &["if_statement", "for_statement", "c_style_for_statement", "while_statement", "case_statement"],
    flat_inc: &[],
    logical_kind: &["list"], // && / || join — dedicated, always counts
    logical_ops: &[],
    nested_fn: &[],
    fn_kinds: &["function_definition"],
    class_kinds: &[],
    import_kinds: &[],
};
