// Live-loop helpers (Phase 2). The native app writes every command to
// ~/Library/Mosh/session/mosh-log.jsonl as it runs; `harvest --watch` (cli.ts)
// re-harvests on each change and appends new tuples. These pure helpers do the
// dedupe + the human-readable rollup, so the watch loop in cli.ts stays a thin
// fs-event wrapper (and these stay unit-testable without timers/fs).

import type { Tuple } from "./tupleSchema";

/** One failing turn, with the offending command(s) named. */
export type TurnFailure = { turnId: string; utterance: string; commands: string[] };

export type LiveReport = {
  total: number;
  clean: number; // appliedClean && replayClean
  undone: number;
  withTaste: number;
  /** The live engine returned ok:false for ≥1 command (engine-down / rejected op). */
  engineFailures: TurnFailure[];
  /** Replay diverged from the live run — a command-surface / allowlist drift. */
  contractFailures: TurnFailure[];
};

/** Tuples whose turnId hasn't been seen yet; mutates `seen` to include them.
 *  Lets the watcher re-harvest the whole (idempotent) log but emit each turn once. */
export function collectFresh(tuples: Tuple[], seen: Set<string>): Tuple[] {
  const fresh: Tuple[] = [];
  for (const t of tuples) {
    if (seen.has(t.turnId)) continue;
    seen.add(t.turnId);
    fresh.push(t);
  }
  return fresh;
}

/** Roll a tuple set up into counts + the two failure classes the harvester already
 *  computes, distinguishing a live-engine rejection (appliedClean=false) from a
 *  replay/contract divergence (replayClean=false). */
export function liveReport(tuples: Tuple[]): LiveReport {
  const engineFailures: TurnFailure[] = [];
  const contractFailures: TurnFailure[] = [];
  let clean = 0;
  let undone = 0;
  let withTaste = 0;

  for (const t of tuples) {
    const o = t.outcome;
    if (o.appliedClean && o.replayClean) clean++;
    if (o.undone) undone++;
    if (o.taste.length > 0) withTaste++;

    if (!o.appliedClean) {
      const bad = t.commands.filter((c) => !c.ok).map((c) => (c.error ? `${c.command} (${c.error})` : c.command));
      engineFailures.push({ turnId: t.turnId, utterance: t.utterance, commands: bad.length ? bad : t.commands.map((c) => c.command) });
    }
    if (!o.replayClean) {
      // Non-agent-callable commands are the canonical allowlist drift; if all are
      // callable the divergence is arg/apply-level, so name the whole turn.
      const drift = t.commands.filter((c) => !c.agentCallable).map((c) => c.command);
      contractFailures.push({ turnId: t.turnId, utterance: t.utterance, commands: drift.length ? drift : t.commands.map((c) => c.command) });
    }
  }

  return { total: tuples.length, clean, undone, withTaste, engineFailures, contractFailures };
}

/** A compact multi-line rendering for the watcher / one-shot `--report`. */
export function formatLiveReport(r: LiveReport): string {
  const lines = [
    `tuples ${r.total} · clean ${r.clean} · undone ${r.undone} · taste ${r.withTaste}` +
      ` · engine-fail ${r.engineFailures.length} · contract-fail ${r.contractFailures.length}`,
  ];
  for (const f of r.engineFailures) lines.push(`  ✗ engine   [${f.turnId}] "${f.utterance}" → ${f.commands.join(", ")}`);
  for (const f of r.contractFailures) lines.push(`  ✗ contract [${f.turnId}] "${f.utterance}" → ${f.commands.join(", ")}`);
  return lines.join("\n");
}
