import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INPUT_HASHES, trainingRows, heldoutShapes, frozenSelection, shapes, shapeSummary, selectedGroups, hash } from "./corpus";
import type { ShapeGroup, ShapeRow } from "./types";

export type Inputs = { readonly root: string; readonly train: string; readonly evalA: string; readonly frozen300: string };
export function inventory(inputs: Inputs) {
  const train = trainingRows(inputs.train);
  const trainGroups = shapes(train.map((row) => ({ id: row.id, shape: row.commands.map((c) => c.command) })));
  const evalA = heldoutShapes(inputs.evalA, INPUT_HASHES.evalA);
  const frozenSource = heldoutShapes(inputs.frozen300, INPUT_HASHES.frozen300);
  const frozen300 = frozenSelection(frozenSource);
  const keys = new Set(trainGroups.map((g) => JSON.stringify(g.shape)));
  const summary = (rows: readonly ShapeRow[]) => ({ ...shapeSummary(shapes(rows)),
    shapeInTraining: rows.filter((r) => keys.has(JSON.stringify(r.shape))).length });
  const selected = selectedGroups(trainGroups);
  const data = {
    baseSha: "0e57fe520d486568e90b674fbc6427e089871f1d",
    inputHashes: INPUT_HASHES, training: shapeSummary(trainGroups),
    evalA: summary(evalA), frozen300: summary(frozen300), frozenSourceRows: frozenSource.length,
    frozenSelectionIdsSha256: hash(frozen300.map((r) => r.id).join("\n") + "\n"),
    selected: { skills: selected.length, rows: selected.reduce((n, g) => n + g.rows.length, 0) },
    emptyRows: trainGroups.find((g) => !g.shape.length)?.rows.length ?? 0,
    huhWithCommands: train.filter((r) => r.intent === "HUH" && r.commands.length).map((r) => r.id),
  };
  return { data, train, trainGroups, selected, evalA, frozen300 };
}
export const shapeLabel = (group: Pick<ShapeGroup, "shape">): string => group.shape.length ? group.shape.join(" → ") : "∅ (no commands)";
export function inventoryMarkdown(inv: ReturnType<typeof inventory>): string {
  const { data } = inv;
  const lines = ["# Mosh skills library v1", "", "## Step 1: measurements", "",
    `Base: \`${data.baseSha}\`. All counts preserve corpus row weighting and exact ordered command repetition.`, "",
    "| Dataset | Rows | Distinct shapes | Shapes for 50% / 80% / 95% | Shape in training |",
    "|---|---:|---:|---|---|",
    ...[["s2-mix-v5", data.training, data.training.rows], ["evalA", data.evalA, data.evalA.shapeInTraining],
      ["frozen300", data.frozen300, data.frozen300.shapeInTraining]].map((entry) => {
        const [name, summary, matching] = entry;
        if (typeof name !== "string" || typeof summary !== "object" || typeof matching !== "number") return "";
        return `| ${name} | ${summary.rows} | ${summary.distinctShapes} | ${[50,80,95].map((p) => summary.thresholds[p]).join(" / ")} | ${matching}/${summary.rows} (${(100 * matching / summary.rows).toFixed(2)}%) |`;
      }), "",
    `The 40 executable shapes cover **${data.selected.rows}/${data.training.rows} (${(100 * data.selected.rows / data.training.rows).toFixed(2)}%)**. ` +
      `${data.emptyRows} empty-command rows remain in the denominator and receive no executable skill.`, "",
    `The frozen source contains ${data.frozenSourceRows} rows; frozen300 uses the evaluator's stable DJB2-id sort followed by slice(0,300). ` +
      `Selected ID list SHA256: \`${data.frozenSelectionIdsSha256}\`.`, "",
    "### Verified input SHA256", "", ...Object.entries(data.inputHashes).map(([name, sha]) => `- ${name}: \`${sha}\``), "",
    "### Complete shape frequencies", "",
  ];
  for (const [label, groups] of [["Training", inv.trainGroups], ["evalA", shapes(inv.evalA)], ["frozen300", shapes(inv.frozen300)]] as const) {
    lines.push(`#### ${label}`, "", "| Rank | Ordered commands | Rows |", "|---:|---|---:|");
    groups.forEach((group, index) => lines.push(`| ${index + 1} | ${shapeLabel(group)} | ${group.rows.length} |`));
    lines.push("");
  }
  return lines.join("\n");
}
export function writeInventory(inputs: Inputs) {
  const inv = inventory(inputs);
  const out = join(inputs.root, "docs/skills");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "measurements.json"), JSON.stringify(inv.data, null, 2) + "\n");
  writeFileSync(join(out, "shapes.json"), JSON.stringify({ train: inv.trainGroups, evalA: shapes(inv.evalA), frozen300: shapes(inv.frozen300) }, null, 2) + "\n");
  writeFileSync(join(out, "REPORT.md"), inventoryMarkdown(inv) + "\n\nImplementation and validation pending. Step 1 is preserved independently.\n");
  return inv;
}
