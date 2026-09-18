import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readNativeContract, checkNativeCommand } from "./nativeContract";
import type { TrainingRow } from "./types";

export function auditCorpus(root: string, rows: readonly TrainingRow[]): void {
  const native = readNativeContract(root);
  const issues = rows.flatMap(row => {
    const reasons = row.commands.flatMap((command, step) => checkNativeCommand(command, native).map(reason => `step ${step + 1}: ${reason}`));
    if (row.intent === "HUH" && row.commands.length) reasons.push("HUH intent contains executable commands");
    row.commands.forEach((command, step) => {
      for (const [arg, value] of Object.entries(command.args)) if (value === null) reasons.push(`step ${step + 1}: explicit null ${command.command}.${arg}`);
    });
    return reasons.length ? [{ rowId: row.id, line: row.line, shape: row.commands.map(c => c.command), reasons }] : [];
  });
  const unresolved = [...native.values()].filter(command => command.unresolved.length);
  writeFileSync(join(root, "docs/skills/corpus-audit.json"), JSON.stringify({
    scope: "Native command/argument-name audit over every training row, plus HUH and null detection; not a complete semantic corpus audit.",
    issues, unresolvedNativeExtractions: unresolved.map(command => ({ command: command.name, reasons: command.unresolved })),
  }, null, 2) + "\n");
}
