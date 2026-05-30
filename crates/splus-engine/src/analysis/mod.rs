//! Analysis tier: tree-sitter parsing, symbol/import extraction, cognitive
//! complexity, and the cross-file reference graph (blast radius).

pub mod complexity;
pub mod graph;
pub mod scip;
pub mod symbols;
pub mod tslang;
