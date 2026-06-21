// Phase-0 harvester/verifier CLI (run via tsx — see package.json scripts).
//
//   npm run harvest -- [<mosh-log.jsonl>] [-o tuples.jsonl]
//   npm run verify  -- <commands.json> [--target snapshot.json]
//
// harvest: read a MoshOps log → versioned trajectory tuples (JSONL).
// verify:  replay a command sequence through the deterministic mock backend and
//          print the verdict (clean-validate / clean-apply / optional snapshot diff).
// Both are audio-free, Python-free, native-build-free.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { harvest } from "./harvester";
import { replay } from "./verifier";
import type { CommandCall } from "./tupleSchema";
import type { Snapshot } from "../types";

const DEFAULT_LOG = join(homedir(), "Library", "Mosh", "session", "mosh-log.jsonl");

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

  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (e) {
    console.error(`harvest: cannot read log: ${logPath}\n  ${(e as Error).message}`);
    return 1;
  }

  const tuples = await harvest(text, { logPath });
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
