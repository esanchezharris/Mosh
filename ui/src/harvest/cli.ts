// Phase-0 harvester/verifier CLI (run via tsx — see package.json scripts).
//
//   npm run harvest -- [<mosh-log.jsonl>] [-o tuples.jsonl]
//   npm run verify  -- <commands.json> [--target snapshot.json]
//
// harvest: read a MoshOps log → versioned trajectory tuples (JSONL). With --watch
//          it tails the live log and appends new tuples as turns complete (Phase 2);
//          with --report it prints the clean/engine-fail/contract-fail rollup.
// verify:  replay a command sequence through the deterministic mock backend and
//          print the verdict (clean-validate / clean-apply / optional snapshot diff).
// Both are audio-free, Python-free, native-build-free.

import { appendFileSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { harvest, harvestUnservedAsks } from "./harvester";
import { collectFresh, formatLiveReport, liveReport } from "./liveHarvest";
import { replay } from "./verifier";
import type { CommandCall } from "./tupleSchema";
import type { Snapshot } from "../types";

const SESSION_DIR = join(homedir(), "Library", "Mosh", "session");
const DEFAULT_LOG = join(SESSION_DIR, "mosh-log.jsonl");
const DEFAULT_TUPLES = join(SESSION_DIR, "tuples.jsonl");

function parseArgs(argv: string[], valueFlags: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (valueFlags.includes(t)) flags[t] = argv[++i] ?? "";
    else if (t.startsWith("-")) flags[t] = "";
    else positional.push(t);
  }
  return { positional, flags };
}

async function cmdHarvest(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv, ["-o", "--out"]);
  const logPath = positional[0] ?? DEFAULT_LOG;
  const out = flags["-o"] || flags["--out"] || "";

  // --watch: Phase-2 live loop — tail the log, append new tuples as turns complete.
  if ("--watch" in flags) return watchHarvest(logPath, out || DEFAULT_TUPLES);

  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (e) {
    console.error(`harvest: cannot read log: ${logPath}\n  ${(e as Error).message}`);
    return 1;
  }
  const tuples = await harvest(text, { logPath });

  // FS-B2a — asks that reached Moshi and produced NO command. Not tuples (there is no
  // trajectory to imitate), so they are printed alongside the rollup rather than mixed
  // into the corpus: each one names a skill the current catalog does not have.
  const unserved = harvestUnservedAsks(text);

  // --report: just the clean / engine-fail / contract-fail rollup (no tuple output).
  if ("--report" in flags) {
    console.log(formatLiveReport(liveReport(tuples)));
    if (unserved.length > 0) {
      console.log(`unserved asks (${unserved.length}) — produced no command:`);
      for (const a of unserved) console.log(`  ? [${a.source}] "${a.utterance}"`);
    }
    return 0;
  }

  const jsonl = tuples.map((t) => JSON.stringify(t)).join("\n") + (tuples.length ? "\n" : "");
  if (out) writeFileSync(out, jsonl);
  else process.stdout.write(jsonl);

  const undone = tuples.filter((t) => t.outcome.undone).length;
  const taste = tuples.filter((t) => t.outcome.taste.length > 0).length;
  const dirty = tuples.filter((t) => !t.outcome.appliedClean).length;
  console.error(
    `harvested ${tuples.length} tuple(s) from ${logPath}${out ? ` → ${out}` : ""}` +
      ` · ${undone} undone · ${taste} with taste labels · ${dirty} not-applied-clean`,
  );
  return 0;
}

// Tail the live MoshOps log: re-harvest on every change (the harvest is idempotent),
// dedupe by turnId, and append only newly-completed turns to the tuples file. The log
// is the single source of truth (the native app writes it synchronously), so this is
// a pure Node sidecar — zero app/C++ change. Runs until Ctrl-C.
async function watchHarvest(logPath: string, outPath: string): Promise<number> {
  const seen = new Set<string>();
  let dirEnsured = false;
  let running = false;
  let pending = false;

  const flush = async (): Promise<void> => {
    if (running) {
      pending = true; // coalesce a change that lands mid-harvest
      return;
    }
    running = true;
    try {
      let text: string;
      try {
        text = readFileSync(logPath, "utf8");
      } catch {
        return; // log not created yet — watchFile will fire when it appears
      }
      const tuples = await harvest(text, { logPath });
      const fresh = collectFresh(tuples, seen);
      if (fresh.length) {
        if (!dirEnsured) {
          mkdirSync(dirname(outPath), { recursive: true });
          dirEnsured = true;
        }
        appendFileSync(outPath, fresh.map((t) => JSON.stringify(t)).join("\n") + "\n");
      }
      const stamp = new Date().toISOString().slice(11, 19);
      console.error(`[${stamp}] +${fresh.length} new tuple(s) → ${outPath}`);
      console.error(formatLiveReport(liveReport(tuples)));
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void flush();
      }
    }
  };

  console.error(`watching ${logPath}\n  → ${outPath}  (Ctrl-C to stop)`);
  await flush(); // catch up on whatever's already in the log
  watchFile(logPath, { interval: 1000 }, () => void flush());
  process.on("SIGINT", () => {
    unwatchFile(logPath);
    console.error("\nstopped.");
    process.exit(0);
  });
  return new Promise<number>(() => {}); // never resolves; lives until SIGINT
}

async function cmdVerify(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv, ["--target"]);
  const file = positional[0];
  if (!file) {
    console.error("verify: usage: verify <commands.json> [--target snapshot.json]");
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`verify: cannot read/parse ${file}: ${(e as Error).message}`);
    return 2;
  }

  // accept either a bare [ {command,args}, ... ] or { commands: [...], target?: Snapshot }
  const commands: CommandCall[] = Array.isArray(parsed)
    ? (parsed as CommandCall[])
    : ((parsed as { commands?: CommandCall[] }).commands ?? []);

  let target: Snapshot | undefined;
  const targetPath = flags["--target"];
  if (targetPath) target = JSON.parse(readFileSync(targetPath, "utf8")) as Snapshot;

  const r = await replay(commands, { target });
  console.log(
    JSON.stringify(
      {
        cleanValidate: r.cleanValidate,
        cleanApply: r.cleanApply,
        diff: r.diff ? { equal: r.diff.equal, changes: r.diff.changes.length } : undefined,
        perCommand: r.perCommand,
      },
      null,
      2,
    ),
  );
  return r.cleanValidate && r.cleanApply && (!r.diff || r.diff.equal) ? 0 : 1;
}

async function main(): Promise<number> {
  const [, , sub, ...rest] = process.argv;
  if (sub === "harvest") return cmdHarvest(rest);
  if (sub === "verify") return cmdVerify(rest);
  console.error(
    "usage:\n" +
      "  harvest [<mosh-log.jsonl>] [-o tuples.jsonl]   (default log: ~/Library/Mosh/session/mosh-log.jsonl)\n" +
      "  harvest --watch [<log>] [-o tuples.jsonl]      (tail the live log → append new tuples; default out: …/session/tuples.jsonl)\n" +
      "  harvest --report [<log>]                       (print the clean / engine-fail / contract-fail rollup)\n" +
      "  verify  <commands.json> [--target snapshot.json]",
  );
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
