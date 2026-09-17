import { cell, percentage, shapeName, type ReportData } from "./reportData";
import { MiningError } from "./types";

export function measurementTables(data: ReportData): string {
  const m = data.measurements;
  const lines = ["## Step 1: measurements", "", `Base: \`${m.baseSha}\`. Counts retain every row and exact ordered command repetition.`, "",
    "| Dataset | Rows | Distinct shapes | Shapes for 50% / 80% / 95% | Shape in training |",
    "|---|---:|---:|---|---|",
    ...[["s2-mix-v5", m.training, m.training.rows], ["evalA", m.evalA, m.evalA.shapeInTraining], ["frozen300", m.frozen300, m.frozen300.shapeInTraining]].map(entry => {
      const [name, summary, matching] = entry;
      if (typeof name !== "string" || typeof summary !== "object" || typeof matching !== "number") throw new MiningError("Invalid measurement row");
      return `| ${name} | ${summary.rows} | ${summary.distinctShapes} | ${[50, 80, 95].map(p => summary.thresholds[p]).join(" / ")} | ${matching}/${summary.rows} (${percentage(matching, summary.rows)}) |`;
    }), "",
    `The ${m.selected.skills} executable shapes cover **${m.selected.rows}/${m.training.rows} (${percentage(m.selected.rows, m.training.rows)})** of training by shape. ` +
      `${m.emptyRows} empty-command rows remain in the denominator and receive no executable skill.`, "",
    `The frozen source contains ${m.frozenSourceRows} rows. Frozen300 uses the evaluator’s stable DJB2-id sort followed by slice(0,300). ` +
      `Selected-ID-list SHA256: \`${m.frozenSelectionIdsSha256}\`.`, "", "### Verified input SHA256", "",
    ...Object.entries(m.inputHashes).sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => `- ${name}: \`${hash}\``), "",
    "### Complete original shape rankings", "",
  ];
  for (const [label, groups] of [["Training", data.shapes.train], ["evalA", data.shapes.evalA], ["frozen300", data.shapes.frozen300]] as const) {
    lines.push(`#### ${label}`, "", "| Rank | Exact ordered commands | Rows |", "|---:|---|---:|");
    groups.forEach((group, index) => lines.push(`| ${index + 1} | ${cell(shapeName(group.shape))} | ${group.rows.length} |`));
    lines.push("");
  }
  return lines.join("\n");
}

export function skillTable(data: ReportData): string {
  const lines = ["## Skill-by-skill validation", "",
    "Pass requires reproduced rows / every provenance row ≥95%. Exact rendering alone does not pass a skill; failed and unverified rows remain in its denominator.", "",
    "| Rank | Skill artifact | Rows | Exact render | Reproduced | Failed | Unverified | Reproduction rate | Pass ≥95% | Undo mode |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---|---|",
  ];
  for (const skill of data.skills) {
    const v = data.validation.skills.find(item => item.id === skill.id);
    if (!v) throw new MiningError(`Missing verdict: ${skill.id}`);
    lines.push(`| ${skill.mining.rank} | [${skill.id}](../../skills/${skill.id}.json) | ${v.rows} | ${v.renderedExactly} | ${v.reproduced} | ${v.failed} | ${v.unverified} | ${percentage(v.reproduced, v.rows)} | ${v.passes ? "PASS" : "NO"} | ${skill.mining.undo} |`);
  }
  return lines.join("\n");
}

export function ownerValues(data: ReportData): string {
  const owner = data.skills.flatMap(skill => skill.slots.filter(slot => slot.default === "NEEDS_OWNER_VALUE").map(slot => ({ skill, slot })));
  const lines = ["## Owner-authored musical values", "",
    `**${owner.length} slots in ${new Set(owner.map(item => item.skill.id)).size} skills** carry \`NEEDS_OWNER_VALUE\`. ` +
      "These markers are rejected by rendering. A training minimum, median, or maximum describes evidence and is never an audible recommendation or a substitute for an owner-supplied value.", "",
    "Statistics below are per distinct generated slot, preserving its original row weighting. Medians are not averaged across skills or notes. Bounds come from the cited native handler; absent bounds mean no fixed range was established there.", "",
    "| Skill | Slot | Unit | Training min | Training median | Training max | Native bounds | Native source |",
    "|---|---|---|---:|---:|---:|---|---|",
  ];
  for (const { skill, slot } of owner) {
    const input = slot.input;
    const stats = input.statistics;
    lines.push(`| ${skill.id} | ${slot.name} | ${cell(input.unit ?? "unspecified")} | ${stats?.min ?? "unavailable"} | ${stats?.median ?? "unavailable"} | ${stats?.max ?? "unavailable"} | ${input.min ?? "not fixed"} … ${input.max ?? "not fixed"} | [source](../../${input.nativeSource.file}#L${input.nativeSource.line}) |`);
  }
  return lines.join("\n");
}

export function uncoveredTable(data: ReportData): string {
  const rowMap = new Map(data.rows.map(row => [row.rowId, row]));
  const lines = ["## Training rows without demonstrated reproduction", "",
    "Every original training shape appears below, including selected shapes with failed or unverified rows. The ID links lead to the exhaustive original row lists; selected row outcomes and reasons are in [row-validation.jsonl](row-validation.jsonl). Shape matches are not treated as successful reproduction.", "",
    "| Training rank | Exact ordered shape | All rows | Unselected | Failed | Unverified | Reproduced | Exhaustive IDs |",
    "|---:|---|---:|---:|---:|---:|---:|---|",
  ];
  for (const [index, group] of data.shapes.train.entries()) {
    const selected = group.rows.flatMap(id => { const row = rowMap.get(id); return row ? [row] : []; });
    lines.push(`| ${index + 1} | ${cell(shapeName(group.shape))} | ${group.rows.length} | ${group.rows.length - selected.length} | ${selected.filter(row => row.status === "failed").length} | ${selected.filter(row => row.status === "unverified").length} | ${selected.filter(row => row.status === "passed").length} | [train[${index}].rows](shapes.json) |`);
  }
  return lines.join("\n");
}

export function heldoutTable(data: ReportData): string {
  const h = data.heldout;
  if (!h) return "## Held-out shape ceilings\n\nPending: heldout.json is absent. No held-out coverage result is claimed.";
  const lines = ["## Held-out shape ceilings", "",
    "These are exact ordered shape-coverage ceilings only. Held-out gold argument values and wording were not read by this report. One skill must match the whole shape; two skills must match a contiguous split in order. Behavioral expressibility and router accuracy remain unverified.", "",
    "| Library | Dataset | All rows | One skill | Two additional | At most two skills |",
    "|---|---|---:|---:|---:|---:|",
  ];
  for (const [label, datasets] of [["Candidates", h.candidates], ["Passed ≥95% only", h.validated]] as const)
    for (const [dataset, coverage] of Object.entries(datasets))
      lines.push(`| ${label} | ${dataset} | ${coverage.rows} | ${coverage.one} (${percentage(coverage.one, coverage.rows)}) | ${coverage.twoAdditional} | ${coverage.atMostTwo} (${percentage(coverage.atMostTwo, coverage.rows)}) |`);
  lines.push("", `Freeze before: \`${h.freezeBefore}\`. Freeze after: \`${h.freezeAfter}\`. ` +
    (h.freezeBefore === h.freezeAfter ? "The recorded hashes match." : "The recorded hashes differ; this held-out evidence is invalid."), "",
    "See [heldout.json](heldout.json) for exhaustive held-out shape outcomes. These results establish no benchmark accuracy or musical acceptance.");
  return lines.join("\n");
}
