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
    }
}

fn run_review(args: ReviewArgs) -> Result<i32> {
    if !is_git_repo(&args.root) {
        anyhow::bail!("{} is not a git repository", args.root.display());
    }

    let mode = if let Some(b) = &args.base {
        DiffMode::Base(b.clone())
    } else if args.staged {
        DiffMode::Staged
    } else {
        DiffMode::Working
    };

    let report = Engine::new(args.root.clone(), mode).review()?;

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
