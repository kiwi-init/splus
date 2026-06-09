/**
 * The protocol-audit ledger — discipline as a checkable invariant, not prose.
 *
 * The MCP server is the one component that deterministically SEES the review
 * protocol happen: `review` hands out the floor and the changed-export
 * contracts, every `inspect` call flows through here, `dismiss`/`accept` record
 * explicit fates. The ledger records those events per repo, and `report` audits
 * them: which changed exports were never interrogated, which floor findings
 * were never explicitly kept / dismissed / accepted. The standard the skill
 * states ("every changed export inspected, every floor finding accounted for")
 * stops being trusted and starts being checked.
 *
 * In-process state, keyed by repo root, reset by each `review` call — a stdio
 * MCP server lives exactly one agent session, which is exactly one review
 * conversation.
 */

export interface ReviewLedger {
  startedAt: string;
  /** Floor finding ids handed to the agent (post-policy, post-suppression). */
  floorIds: Set<string>;
  /** Floor ids explicitly resolved through dismiss/accept. */
  resolved: Map<string, "dismissed" | "accepted">;
  /** Changed exported symbols — the contracts the directive demands traced. */
  changedSymbols: Array<{ file: string; symbol: string }>;
  /** Symbols interrogated via `inspect` callers / blast_radius. */
  inspectedSymbols: Set<string>;
  /** Count of successful `inspect` calls (the interrogation trail). */
  inspectCalls: number;
}

const ledgers = new Map<string, ReviewLedger>();

/** Start (or restart) the ledger for a repo — called by `review`. */
export function startLedger(
  repo: string,
  floorIds: string[],
  changedSymbolLines: string[],
): void {
  ledgers.set(repo, {
    startedAt: new Date().toISOString(),
    floorIds: new Set(floorIds),
    resolved: new Map(),
    changedSymbols: parseChangedSymbols(changedSymbolLines),
    inspectedSymbols: new Set(),
    inspectCalls: 0,
  });
}

export function ledgerFor(repo: string): ReviewLedger | undefined {
  return ledgers.get(repo);
}

/** Record a successful `inspect` call against the live review, if any. */
export function recordInspect(repo: string, kind: string, target: string): void {
  const led = ledgers.get(repo);
  if (!led) return;
  led.inspectCalls += 1;
  // Contract traces are interrogations of a symbol's consumers.
  if (kind === "callers" || kind === "blast_radius") led.inspectedSymbols.add(target);
}

/** Record an explicit fate for a finding id (from `dismiss` / `accept`). */
export function recordResolution(repo: string, id: string, fate: "dismissed" | "accepted"): void {
  ledgers.get(repo)?.resolved.set(id, fate);
}

/** `floor` re-grounds mid-review: anything it showed the agent joins the floor. */
export function extendFloor(repo: string, ids: string[]): void {
  const led = ledgers.get(repo);
  if (!led) return;
  for (const id of ids) led.floorIds.add(id);
}

/** Parse `changedExportedSymbols` lines (`"src/a.ts: foo, bar"`) into pairs. */
export function parseChangedSymbols(lines: string[]): Array<{ file: string; symbol: string }> {
  const out: Array<{ file: string; symbol: string }> = [];
  for (const line of lines) {
    const i = line.indexOf(": ");
    if (i === -1) continue;
    const file = line.slice(0, i);
    for (const raw of line.slice(i + 2).split(",")) {
      const symbol = raw.trim();
      if (symbol) out.push({ file, symbol });
    }
  }
  return out;
}

const SHOWN = 12;

/**
 * The deterministic audit block `report` prepends to the render instructions.
 * Computed purely from this session's recorded tool calls — the agent can close
 * the gaps it lists, but cannot talk its way past them.
 */
export function auditBlock(repo: string, keptIds?: string[]): string {
  const led = ledgers.get(repo);
  if (!led) {
    return [
      "=== Splus · protocol audit ===",
      "No review ledger for this repo in this session — call `review` first so the audit can certify coverage.",
      "=== end audit ===",
    ].join("\n");
  }
  const kept = new Set(keptIds ?? []);
  const keptOnFloor = [...led.floorIds].filter((id) => kept.has(id)).length;
  const unresolved = [...led.floorIds].filter((id) => !led.resolved.has(id) && !kept.has(id));
  const untraced = led.changedSymbols.filter((s) => !led.inspectedSymbols.has(s.symbol));
  const traced = led.changedSymbols.length - untraced.length;
  const dismissed = [...led.resolved.values()].filter((v) => v === "dismissed").length;
  const accepted = [...led.resolved.values()].filter((v) => v === "accepted").length;

  const lines = [
    "=== Splus · protocol audit (deterministic — computed from this session's tool calls) ===",
    `Contract traces: ${traced}/${led.changedSymbols.length} changed exported symbol(s) interrogated via \`inspect\` (callers / blast_radius); ${led.inspectCalls} inspect call(s) total.`,
  ];
  lines.push(...untraced.slice(0, SHOWN).map((s) => `  ✗ never inspected: ${s.symbol} (${s.file})`));
  if (untraced.length > SHOWN) lines.push(`  …and ${untraced.length - SHOWN} more`);
  lines.push(
    `Floor coverage: ${led.floorIds.size} floor finding(s) → ` +
      `${keptIds ? `${keptOnFloor} kept` : "kept not declared"} · ${dismissed} dismissed · ` +
      `${accepted} accepted · ${unresolved.length} unaccounted.`,
  );
  if (!keptIds) {
    lines.push("  (Pass `keptIds` — the floor ids your verified report keeps — to certify floor coverage.)");
  }
  lines.push(...unresolved.slice(0, SHOWN).map((id) => `  ✗ unaccounted floor finding: ${id}`));
  if (unresolved.length > SHOWN) lines.push(`  …and ${unresolved.length - SHOWN} more`);

  if (untraced.length || unresolved.length) {
    lines.push(
      "",
      "AUDIT INCOMPLETE — a great review leaves nothing unaccounted. Trace the symbols above " +
        "(`inspect callers` / `inspect blast_radius`, then open the call sites) and give every " +
        "floor finding an explicit fate (keep it in the report, `dismiss`, or `accept`) before " +
        "writing the report.",
    );
  } else {
    lines.push("", "AUDIT CLEAN — every changed export interrogated, every floor finding accounted for.");
  }
  lines.push("=== end audit ===");
  return lines.join("\n");
}
