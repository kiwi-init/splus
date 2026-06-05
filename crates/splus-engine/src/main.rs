//! `splus-engine` — the deterministic review engine binary.
//!
//! The TypeScript surfaces (CLI, GitHub App) shell out to this and consume its
//! JSON. It is also runnable directly: `splus-engine review --staged`.

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use splus_engine::diff::{is_git_repo, DiffMode};
use splus_engine::model::Severity;
use splus_engine::pipeline::Engine;
use splus_engine::render::{self, Theme};
use std::path::PathBuf;
use std::process::exit;

#[derive(Parser)]
#[command(
    name = "splus-engine",
    version,
    about = "Splus deterministic code-review engine (diff-scoped, clean-as-you-code, zero-inference)"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Review a diff: staged changes, all working changes, or base..HEAD.
    Review(ReviewArgs),
    /// Inspect code intelligence on demand — the engine "on tap". Answers one
    /// question (definition / callers / blast_radius / complexity / exports /
    /// imports) as JSON, so the agent can investigate instead of triaging a list.
    Inspect(InspectArgs),
}

#[derive(Args)]
struct InspectArgs {
    /// Repository root.
    #[arg(long, default_value = ".")]
    root: PathBuf,
    /// What to ask: definition | callers | blast_radius | complexity | exports | imports.
    #[arg(long)]
    kind: String,
    /// The subject: a symbol name (definition/callers/blast_radius) or a file path
    /// (complexity/exports/imports).
    #[arg(long)]
    target: String,
    /// Pin the defining file for a symbol query (disambiguates same-named symbols).
    #[arg(long)]
    file: Option<String>,
    /// SCIP index for the precise blast-radius tier (else auto-detected).
    #[arg(long)]
    scip: Option<PathBuf>,
}

#[derive(Args)]
struct ReviewArgs {
    /// Repository root.
    #[arg(long, default_value = ".")]
    root: PathBuf,
    /// Review staged changes (`git diff --cached`).
    #[arg(long, conflicts_with = "base")]
    staged: bool,
    /// Review against a base ref (PR-style `base...HEAD`).
    #[arg(long)]
    base: Option<String>,
    /// Review the entire committed repository (every file as newly added).
    #[arg(long, conflicts_with_all = ["base", "staged"])]
    all: bool,
    /// Path to a SCIP index for the precise blast-radius tier (else auto-detected
    /// from index.scip / .splus-cache/index.scip).
    #[arg(long)]
    scip: Option<PathBuf>,
    /// Also emit cognitive-complexity maintainability metrics (off by default —
    /// they are near-noise and dilute the grounded floor).
    #[arg(long)]
    metrics: bool,
    /// Output format: pretty | json | sarif.
    #[arg(long, default_value = "pretty")]
    format: String,
    /// Exit non-zero if any finding is at or above this severity
    /// (critical|high|medium|low|info).
    #[arg(long)]
    fail_on: Option<String>,
    /// Disable ANSI colors.
    #[arg(long)]
    no_color: bool,
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Commands::Review(args) => match run_review(args) {
            Ok(code) => exit(code),
            Err(e) => {
                eprintln!("splus: error: {e:#}");
                exit(2);
            }
        },
        Commands::Inspect(args) => match run_inspect(args) {
            Ok(()) => exit(0),
            Err(e) => {
                eprintln!("splus: error: {e:#}");
                exit(2);
            }
        },
    }
}

/// Auto-detect a SCIP index at the conventional locations under `root`.
fn detect_scip(root: &PathBuf, explicit: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        return p.exists().then_some(p);
    }
    ["index.scip", ".splus-cache/index.scip"]
        .into_iter()
        .map(|c| root.join(c))
        .find(|p| p.exists())
}

fn run_inspect(args: InspectArgs) -> Result<()> {
    let scip = detect_scip(&args.root, args.scip);
    let value = splus_engine::inspect::inspect(
        &args.root,
        &args.kind,
        &args.target,
        args.file.as_deref(),
        scip.as_deref(),
    )?;
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn run_review(args: ReviewArgs) -> Result<i32> {
    if !is_git_repo(&args.root) {
        anyhow::bail!("{} is not a git repository", args.root.display());
    }

    let mode = if args.all {
        DiffMode::All
    } else if let Some(b) = &args.base {
        DiffMode::Base(b.clone())
    } else if args.staged {
        DiffMode::Staged
    } else {
        DiffMode::Working
    };

    let mut engine = Engine::new(args.root.clone(), mode);
    engine.scip_path = args.scip.clone();
    engine.metrics = args.metrics;
    let report = engine.review()?;

    let color = !args.no_color && std::env::var_os("NO_COLOR").is_none();
    let theme = Theme { color };
    let out = match args.format.as_str() {
        "json" => render::json(&report),
        "sarif" => render::sarif(&report),
        "pretty" => render::pretty(&report, &theme),
        other => anyhow::bail!("unknown --format: {other} (use pretty|json|sarif)"),
    };
    println!("{out}");

    if let Some(fo) = &args.fail_on {
        let threshold = Severity::parse(fo)
            .ok_or_else(|| anyhow::anyhow!("invalid --fail-on severity: {fo}"))?;
        let triggered = report
            .findings
            .iter()
            .any(|f| f.severity.rank() >= threshold.rank());
        if triggered {
            return Ok(1);
        }
    }
    Ok(0)
}
