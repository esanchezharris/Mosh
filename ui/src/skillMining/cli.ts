import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { inventory, writeInventory, type Inputs } from "./inventory";
import { trainingRows } from "./corpus";
import { writeSkills } from "./mine";
import { loadSkills, validateLibrary } from "./validation";
import { auditCorpus } from "./audit";
import { freezeLibrary, verifyFreeze, readHeldout } from "./heldout";
import { generateReport } from "./report";
import { MiningError } from "./types";
import { checkDeterminism } from "./determinism";

const actionSchema = z.enum(["measure", "mine", "validate", "freeze", "heldout", "report", "verify", "check"]);
const verdictSchema = z.object({ skills: z.array(z.object({
  id: z.string(), rows: z.number(), renderedExactly: z.number(), reproduced: z.number(),
  failed: z.number(), unverified: z.number(), passRate: z.number(), passes: z.boolean(),
})) });
export const HELP = `Mosh skills library offline validator
Usage: npm exec -- tsx src/skillMining/cli.ts <action> [options]
Actions: measure, mine, validate, freeze, heldout, report, verify, check
Options: --root PATH --train PATH --evalA PATH --frozen300 PATH --help
Order: measure -> mine -> validate -> freeze -> heldout -> report -> verify
After freeze, measure/mine/validate refuse mutation. Validation retains missing authentic setups as unverified.
The existing r4 mock replay path is exercised by Vitest fixtures, never invented corpus setups.
`;
export function parseArgs(args: readonly string[]) {
  const defaults: Inputs = {
    root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    train: join(homedir(), "Mosh/service/sft/.sft-data/s2-mix-v5-prep/train.jsonl"),
    evalA: join(homedir(), "Library/Mosh/work/gate/rerun-evals/evalA.eval.jsonl"),
    frozen300: join(homedir(), "Library/Mosh/work/gate/rerun-evals/frozen300.test.eval.jsonl"),
  };
  if (args.length === 1 && args[0] === "--help") return { help: true, inputs: defaults, action: "verify" };
  const action = actionSchema.parse(args[0]);
  const options: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !["root", "train", "evalA", "frozen300"].includes(key) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new MiningError(`Unknown option or missing path: ${args[i]}`);
    if (key in options) throw new MiningError(`Repeated option: ${args[i]}`);
    options[key] = resolve(args[i + 1]);
  }
  return { help: false, action, inputs: { ...defaults, ...options } };
}
export async function main(args: readonly string[]): Promise<void> {
  const { help, action, inputs } = parseArgs(args);
  if (help) { process.stdout.write(HELP); return; }
  if (["measure", "mine", "validate"].includes(action) && existsSync(join(inputs.root, "docs/skills/FREEZE.json")))
    throw new MiningError("Library is frozen; only heldout/report/verify are allowed");
  switch (action) {
    case "measure": writeInventory(inputs); break;
    case "mine": {
      const inv = inventory(inputs);
      writeSkills(inputs.root, inv.selected, inv.train); break;
    }
    case "validate": {
      const rows = trainingRows(inputs.train);
      auditCorpus(inputs.root, rows);
      await validateLibrary({ root: inputs.root, skills: loadSkills(inputs.root), rows, setups: new Map() }); break;
    }
    case "freeze": checkDeterminism(inputs); freezeLibrary(inputs.root); break;
    case "heldout": {
      const verdict = verdictSchema.parse(JSON.parse(readFileSync(join(inputs.root, "docs/skills/validation.json"), "utf8")));
      readHeldout(inputs, loadSkills(inputs.root), verdict.skills); break;
    }
    case "report": generateReport(inputs.root); break;
    case "check": checkDeterminism(inputs); break;
    case "verify": process.stdout.write(`${verifyFreeze(inputs.root)}\n`); break;
    default: throw new MiningError(`Unknown action: ${action}`);
  }
  process.stdout.write(`${action}: complete\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
