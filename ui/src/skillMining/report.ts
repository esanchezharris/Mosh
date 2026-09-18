import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { array, record, type Json } from "./types";
import { reportData, percentage, cell, type ReportData } from "./reportData";
import { measurementTables, skillTable, ownerValues, uncoveredTable, heldoutTable } from "./reportTables";

function outcome(data: ReportData): string {
  const all = data.measurements.training.rows;
  const selected = data.rows.length;
  const exact = data.rows.filter(row => row.renderedExactly).length;
  const reproduced = data.rows.filter(row => row.status === "passed").length;
  const failed = data.rows.filter(row => row.status === "failed").length;
  const unverified = data.rows.filter(row => row.status === "unverified").length;
  const passed = data.validation.skills.filter(skill => skill.passes).length;
  const missingSetup = data.rows.filter(row => row.reasons.some(reason => reason.includes("setup/snapshot/history unavailable"))).length;
  const dispositions = [["Reproduced", reproduced], ["Selected but failed", failed], ["Selected but unverified", unverified], ["Shape outside the selected executable library", all - selected]] as const;
  return ["## Observed result and denominator", "",
    `**${passed}/${data.skills.length} skills pass the ≥95% reproduction requirement.** ` +
      `Exact command rendering succeeds for ${exact}/${selected} selected rows (${percentage(exact, selected)}); ` +
      `${reproduced}/${selected} rows (${percentage(reproduced, selected)}) have demonstrated reproduction.`, "",
    "| Training disposition | Rows | Share of the entire training corpus |", "|---|---:|---:|",
    ...dispositions.map(([label, n]) => `| ${label} | ${n} | ${percentage(n, all)} |`), "",
    `Full denominator: **${all} rows**. Missing authentic setup/snapshot/history is explicitly recorded for **${missingSetup} selected rows**. ` +
      "A failed schema or rendering row may also lack setup; earlier failure does not establish setup availability. No row was discarded to improve a pass rate.", "",
    "Reproduction requires authentic starting state, successful ordered execution, and independently observable command effects. A successful response, a matching template, or a mock’s generic ok result is insufficient. Native audio, plugin windows, actual recording, service-generated lyrics, and owner listening are separate acceptance surfaces.",
  ].join("\n");
}

function evidence(title: string, file: string, value: Json | undefined): string {
  if (value === undefined) return `## ${title}\n\nPending: ${file} is absent; no passing evidence is inferred.`;
  return [`## ${title}`, "", `Recorded evidence: [${file}](${file}).`, "", "```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

function defects(data: ReportData): string {
  const count = (command: string, reason: string): number => data.rows.filter(row =>
    data.skills.find(skill => skill.id === row.skillId)?.mining.shape.includes(command)
    && row.reasons.some(text => text.includes(reason))).length;
  const audit = record(data.audit);
  const issues = array(audit.issues);
  const unresolved = array(audit.unresolvedNativeExtractions);
  const auditReasons = issues.map(issue => array(record(issue).reasons).filter((reason): reason is string => typeof reason === "string"));
  const auditCounts = (fragment: string) => ({
    rows: auditReasons.filter(reasons => reasons.some(reason => reason.includes(fragment))).length,
    occurrences: auditReasons.flat().filter(reason => reason.includes(fragment)).length,
  });
  const details = [
    ["Skeleton wait is explicitly null (overlaps null-grid rows)", "explicit null build_skeleton_from_clip.wait"],
    ["Unselected sketch_beatbox.bars is explicitly null", "explicit null sketch_beatbox.bars"],
    ["Unselected create_lyric_sheet.sectionId is an unknown native argument", "create_lyric_sheet: unknown native argument: sectionId"],
    ["Unselected set_lyric_constraint.sectionId is an unknown native argument", "set_lyric_constraint: unknown native argument: sectionId"],
    ["Unselected set_note has unresolved extraction, not proven native incompatibility", "set_note: unresolved native contract"],
  ] as const;
  return ["## Corpus defects and native-contract differences", "",
    `The measurement pass found **${data.measurements.huhWithCommands.length} HUH rows with executable commands**, at original training lines 3672, 11970, 11971, and 11972. ` +
      "They remain in the full denominator. Their immutable provenance IDs are:", "",
    ...data.measurements.huhWithCommands.map(id => `- \`${id}\``), "",
    "Selected-row failures are retained without coercing null to absence, silently clamping a gold value, or rewriting an unsupported action:", "",
    "| Observed corpus defect | Affected rows | Treatment |", "|---|---:|---|",
    `| Explicit null skeleton grid | ${count("build_skeleton_from_clip", "Invalid string value")} | A present null does not satisfy the string slot; the row fails exact rendering. |`,
    `| Master-volume db = -100 | ${count("set_master_volume", "numeric constraints")} | Native master range is -48..6 dB; preserving the gold value fails bounded rendering. |`,
    `| Transport action = seek | ${count("set_transport", "closed choices")} | Native seeks through position; seek is not a recognized action choice. It is not rewritten. |`, "",
    data.audit === undefined ? "The whole-corpus native command/argument audit is pending; corpus-audit.json is absent." :
      `The [whole-corpus audit](corpus-audit.json) covers all ${data.measurements.training.rows} training rows and records ${issues.length} rows with native-name, HUH, or explicit-null issues. ` +
      `It also records ${unresolved.length} unresolved native handler extractions. Unresolved extraction is an evidence limitation, not proof that the native command is unsupported. ` +
      "The artifact includes exhaustive row IDs, command shapes, reasons, and extraction diagnostics; this is not a complete semantic corpus audit.", "",
    ...(data.audit === undefined ? [] : ["| Whole-corpus audit detail | Distinct rows | Diagnostic occurrences |", "|---|---:|---:|",
      ...details.map(([label, fragment]) => { const counts = auditCounts(fragment); return `| ${label} | ${counts.rows} | ${counts.occurrences} |`; }), "",
      "Rows and diagnostic occurrences are different units; one row may have several steps or overlapping defects. The counts above must not be added to obtain a unique-row total.", ""]),
    "Source disagreements and deliberately narrower catalog declarations:", "",
    "- The [documented transport action list](../02_MOSHOPS_CONTRACT.md#L41) omits continue, to_start, and to_end, all handled by [native transport](../../src/moshops/MoshOps.TempoProject.cpp#L54) and its [navigation branches](../../src/moshops/MoshOps.TempoProject.cpp#L148).",
    "- The [agent catalog](../../ui/src/agent/commands.ts#L124) describes note velocity as 0..127; the [native add-note handler](../../src/moshops/MoshOps.cpp#L2478) clamps it to 1..127.",
    "- The [catalog’s transport choices](../../ui/src/agent/commands.ts#L172) omit continue, which the [native transport handler](../../src/moshops/MoshOps.TempoProject.cpp#L54) handles. Position is the seek field.",
    "- The [catalog’s skeleton description](../../ui/src/agent/commands.ts#L280) says no words; [native extraction](../../src/moshops/MoshOps.Lyrics.cpp#L835) can retain sung words verbatim.",
    "- The [catalog’s ripple hint](../../ui/src/agent/commands.ts#L73) excludes trackId generally; the [native restriction](../../src/moshops/MoshOps.Clips.cpp#L368) rejects a resolved different destination.",
    "- Native defaults may depend on state: [trim](../../src/moshops/MoshOps.Clips.cpp#L415) retains omitted values; [MIDI-clip creation](../../src/moshops/MoshOps.cpp#L1824) can create a track. An unavailable snapshot never becomes an invented constant.",
    "- The [track-fader handler](../../src/moshops/MoshOps.Tracks.cpp#L892) does not apply its linked-followers’ -70..6 dB clamp to the selected-track input. The [master fader](../../src/moshops/MoshOps.Mixer.cpp#L381) has its own -48..6 dB clamp.",
  ].join("\n");
}

function readiness(data: ReportData): string {
  const slots = data.skills.flatMap(skill => skill.slots);
  const counts = { choice_static: 0, choice_snapshot: 0, set: 0, flag: 0, number: 0, text: 0 };
  for (const slot of slots) counts[slot.input.kind]++;
  const numericChoices = slots.filter(slot => slot.type === "number" && slot.input.kind === "choice_static").length;
  const selectors = [...new Set(slots.flatMap(slot => slot.input.selector ? [slot.input.selector] : []))].sort();
  return ["## Structured-question readiness", "",
    `The current artifacts contain **${slots.length} slots**, ${slots.filter(slot => slot.input.question.trim()).length} nonempty questions, ` +
      `and ${slots.filter(slot => slot.input.presenceQuestion).length} explicit optional-presence questions. Counts below classify the stored input kind, not a model’s success rate.`, "",
    "| Input kind | Slots |", "|---|---:|", `| Static choices | ${counts.choice_static} |`,
    `| Snapshot or explicit-catalog choices | ${counts.choice_snapshot} |`, `| Boolean choices | ${counts.flag} |`,
    `| Numeric entry | ${counts.number} |`, `| Free text | ${counts.text} |`, `| Sets | ${counts.set} |`, "",
    `${numericChoices} static-choice slots are numeric native domains, such as power-of-two time-signature denominators. ` +
      "They remain numeric in emitted commands, and owner-value policy still applies. Arbitrary quantities and observed training values are not converted into enumerated choices.", "",
    "Snapshot choices resolve through the current native fields or an explicitly supplied catalog response:", "",
    ...selectors.map(selector => `- \`${cell(selector)}\``), "",
    "The offline checks reject IDs absent from the supplied snapshot and ambiguous target scopes. The caller must supply a fresh snapshot; its freshness is not independently established here. Track, clip, section, plugin, and note choices are not filled with corpus IDs. Plugin and note indices retain native snapshot identities.", "",
    "[Jev’s structured-selection source](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is a design reference for question-based input collection. " +
      "These counts establish metadata readiness only: no Jev integration, benchmark score, routing accuracy, successful user dialogue, or musical-quality claim follows from them.",
  ].join("\n");
}

function boundaries(data: ReportData): string {
  const modes = { per_mutation: 0, none: 0, history: 0 };
  for (const skill of data.skills) modes[skill.mining.undo]++;
  return ["## Undo and materialized transactions", "",
    `${modes.per_mutation} skills use per-mutation native transactions, ${modes.none} change non-undoable state, and ${modes.history} navigate existing history. ` +
      "A mined skill is a template, not a new atomic transaction boundary.", "",
    "The eight-note shape emits eight separate add_note calls, each with its [own native transaction](../../src/moshops/MoshOps.cpp#L2481). " +
      "It does not satisfy the original corpus system’s one-undo promise for the whole eight-command trajectory. The native note-array form is a different command shape; this miner preserves the original eight unbatched calls rather than silently replacing them.", "",
    "Opening a transaction is not proof that a mutation was materialized. Track and master faders use [undoable value actions](../../src/moshops/MoshOpsInternal.h#L77); " +
      "[track-volume plugin creation](../../src/moshops/MoshOps.Tracks.cpp#L870) occurs inside its transaction. Actual undo/redo restoration still needs starting-state and effect evidence.", "",
    "[Skeleton generation](../../src/moshops/MoshOps.Lyrics.cpp#L816) opens its undo transaction only when a successful result lands. " +
      "[Test-tone creation](../../src/moshops/MoshOps.Clips.cpp#L325) generates a file before delegating to import_clip; import undo does not remove the generated source file. " +
      "Save, transport, monitoring, record-arm, metronome, and musical-key preferences are not ordinary undoable edit steps.", "",
    "## Schema extensions and runtime boundary", "",
    "The existing [Python base schema](../../service/skills/schema.py) field layout is retained: name, description, slots, template.commands, predicates, provenance, and triggers. " +
      "This artifact format adds schemaVersion, stable id, 5–10 examples, slots[].input question/choice/constraint/source/statistics metadata, and mining rank/shape/bindings/undo metadata. " +
      "slots[].default is already a base-schema extension; here NEEDS_OWNER_VALUE is a refusal marker rather than a representative recommendation.", "",
    "The stored template deliberately retains the existing literal {slot} placeholder syntax, rather than the requested ${slot} notation. " +
      "Placeholders occupy a whole JSON value. A {stepN.result.field} reference resolves field beneath a successful prior response’s data object, preserving its native result envelope. " +
      "Missing or unsuccessful results fail rendering instead of supplying a guessed ID; see the [renderer](../../ui/src/skillMining/render.ts).", "",
    "Stored slot types are string, number, boolean, list<note>, list<string>, list<number>, and list<param>; the separate six input kinds are choice_static, choice_snapshot, set, flag, number, and text. " +
      "The generated top-40 corpus shapes use scalar arguments. A numeric static choice retains a number in the command, and a list type does not turn repeated command steps into a batch.", "",
    "snapshot_choice and command_effect are [offline predicate types](../../ui/src/skillMining/types.ts), distinct from the legacy router’s predicate vocabulary. " +
      "The [mined Python adapter](../../service/skills/mined_schema.py) preserves and validates the richer portable artifact; the legacy Skill adapter alone does not preserve its added metadata or execute its new predicates. " +
      "The generated catalog is not wired into the production brain/router, and no model weights or production UI were changed by this mining work.",
  ].join("\n");
}

export function generateReport(root: string): void {
  const data = reportData(root);
  const sections = ["# Mosh skills library v1", outcome(data), measurementTables(data), skillTable(data),
    ownerValues(data), uncoveredTable(data), defects(data),
    evidence("Authentic setup recovery", "setup-recovery.json", data.setup), boundaries(data),
    heldoutTable(data), readiness(data), evidence("Verification gates", "gates.json", data.gates),
    "## Reproducible artifacts\n\n[Measurements](measurements.json), [complete shapes and row IDs](shapes.json), " +
      "[skill verdicts](validation.json), and [per-row validation](row-validation.jsonl) are the report’s quantitative sources. " +
      "Optional evidence remains explicitly pending until its artifact is present. The generator reads current skills and aggregate evidence only; it does not open held-out raw arguments or wording."];
  writeFileSync(join(root, "docs/skills/REPORT.md"), sections.join("\n\n") + "\n");
}
