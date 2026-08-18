// Task 6 — strict, bounded parsing/validation of `evals.jsonl` against the LOCKED
// `EvalCaseV1` shape (contracts.ts). Purely structural/static validation; runtime
// prohibited-effect and postcondition proof is Slice E's job over a live/mock Mosh session.

import { FOUNDRY_STORAGE_LIMITS_V1, type EvalCaseV1, type EvalExpectedOutcomeV1, type SelectedJourneyActionV1 } from "./contracts";

export type ParseIssueV1 = { path: string; message: string };
export type ParseEvalCasesResultV1 = { ok: true; value: readonly EvalCaseV1[] } | { ok: false; issues: readonly ParseIssueV1[] };

const SELECTED_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "session-control": ["play", "stop", "from_start", "save", "undo", "redo"],
  "capture-review-choose-take": ["record_start", "record_stop", "audition", "again", "keep"],
  "explicit-balance": ["mute", "unmute", "solo", "set_level"],
  "load-named-plugin": ["load"],
});

const NEGATIVE_CATEGORIES = new Set(["negative", "ambiguity", "stale_state", "malformed_input", "injection", "expected_failure"]);
const INVALID_FILL_PHASES = new Set(["none", "candidate_selection", "slot_validation", "entity_resolution", "preflight"]);
const EVIDENCE_LEVELS = new Set(["schema", "mock", "native", "packaged", "physical"]);
const HEX64_REGEX = /^[0-9a-f]{64}$/;

// Every allowlisted `SkillReasonCodeV1` (spec's v1 reason-code allowlist), minus the four the
// "blocked" outcome kind explicitly excludes (those belong to "unsupported"/"needs_choice").
const BLOCKED_REASON_CODES = new Set([
  "missing_slot",
  "invalid_slot",
  "missing_target",
  "stale_context",
  "observation_failed",
  "manifest_stale",
  "command_failed",
  "rollback_failed",
  "postcondition_failed",
  "missing_primitive",
  "provider_unavailable",
  "timeout",
]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateSelected(value: unknown, path: string, issues: ParseIssueV1[]): SelectedJourneyActionV1 | null {
  if (value === null || typeof value !== "object") {
    issues.push({ path, message: "must be an object" });
    return null;
  }
  const v = value as Record<string, unknown>;
  const actions = SELECTED_ACTIONS[v.journeyId as string];
  if (actions === undefined) {
    issues.push({ path: `${path}.journeyId`, message: `unknown journeyId: ${JSON.stringify(v.journeyId)}` });
    return null;
  }
  if (!actions.includes(v.action as string)) {
    issues.push({ path: `${path}.action`, message: `unknown action "${String(v.action)}" for journey "${String(v.journeyId)}"` });
    return null;
  }
  return { journeyId: v.journeyId, action: v.action } as SelectedJourneyActionV1;
}

function validateExpectedOutcome(value: unknown, path: string, issues: ParseIssueV1[]): EvalExpectedOutcomeV1 | null {
  if (value === null || typeof value !== "object") {
    issues.push({ path, message: "must be an object" });
    return null;
  }
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "completed":
      if (v.code !== null) {
        issues.push({ path: `${path}.code`, message: 'must be null when kind is "completed"' });
        return null;
      }
      return { kind: "completed", code: null };
    case "needs_choice":
      if (v.code !== "ambiguous_skill" && v.code !== "ambiguous_target") {
        issues.push({ path: `${path}.code`, message: 'must be "ambiguous_skill" or "ambiguous_target"' });
        return null;
      }
      return { kind: "needs_choice", code: v.code };
    case "blocked":
      if (!BLOCKED_REASON_CODES.has(v.code as string)) {
        issues.push({ path: `${path}.code`, message: `invalid blocked reason code: ${JSON.stringify(v.code)}` });
        return null;
      }
      return { kind: "blocked", code: v.code } as EvalExpectedOutcomeV1;
    case "unsupported":
      if (v.code !== "no_match" && v.code !== "unsupported_intent") {
        issues.push({ path: `${path}.code`, message: 'must be "no_match" or "unsupported_intent"' });
        return null;
      }
      return { kind: "unsupported", code: v.code };
    default:
      issues.push({ path: `${path}.kind`, message: `unknown outcome kind: ${JSON.stringify(v.kind)}` });
      return null;
  }
}

function validateOneCase(value: unknown, lineNumber: number, seenIds: Set<string>): { case: EvalCaseV1 | null; issues: ParseIssueV1[] } {
  const issues: ParseIssueV1[] = [];
  if (value === null || typeof value !== "object") {
    return { case: null, issues: [{ path: `line ${lineNumber}`, message: "not an object" }] };
  }
  const v = value as Record<string, unknown>;
  const path = `line ${lineNumber}`;

  if (v.schemaVersion !== 1) issues.push({ path: `${path}.schemaVersion`, message: "must be 1" });
  if (typeof v.id !== "string" || v.id.length === 0) {
    issues.push({ path: `${path}.id`, message: "must be a non-empty string" });
  } else if (seenIds.has(v.id)) {
    issues.push({ path: `${path}.id`, message: `duplicate eval case id: ${v.id}` });
  }
  const selected = validateSelected(v.selected, `${path}.selected`, issues);
  if (typeof v.supported !== "boolean") issues.push({ path: `${path}.supported`, message: "must be a boolean" });
  if (typeof v.utterance !== "string") issues.push({ path: `${path}.utterance`, message: "must be a string" });
  if (typeof v.fixtureSha256 !== "string" || !HEX64_REGEX.test(v.fixtureSha256)) {
    issues.push({ path: `${path}.fixtureSha256`, message: "must be 64 lowercase hex characters" });
  }
  if (typeof v.initialStateSha256 !== "string" || !HEX64_REGEX.test(v.initialStateSha256)) {
    issues.push({ path: `${path}.initialStateSha256`, message: "must be 64 lowercase hex characters" });
  }
  const expectedOutcome = validateExpectedOutcome(v.expectedOutcome, `${path}.expectedOutcome`, issues);
  if (!isStringArray(v.prohibitedEffects)) issues.push({ path: `${path}.prohibitedEffects`, message: "must be a string array" });
  if (!Array.isArray(v.finalStatePredicates)) issues.push({ path: `${path}.finalStatePredicates`, message: "must be an array" });
  if (typeof v.evidenceLevel !== "string" || !EVIDENCE_LEVELS.has(v.evidenceLevel)) {
    issues.push({ path: `${path}.evidenceLevel`, message: `unknown evidence level: ${JSON.stringify(v.evidenceLevel)}` });
  }
  const scoringCategory = v.scoringCategory;
  const isSelection = scoringCategory === "selection";
  if (!isSelection && !NEGATIVE_CATEGORIES.has(scoringCategory as string)) {
    issues.push({ path: `${path}.scoringCategory`, message: `unknown scoring category: ${JSON.stringify(scoringCategory)}` });
  }
  const invalidFillPhase = v.invalidFillPhase;
  if (typeof invalidFillPhase !== "string" || !INVALID_FILL_PHASES.has(invalidFillPhase)) {
    issues.push({ path: `${path}.invalidFillPhase`, message: `unknown invalidFillPhase: ${JSON.stringify(invalidFillPhase)}` });
  }

  // Supported <=> scoringCategory:"selection" and invalidFillPhase:"none" (plan Task 6).
  if (v.supported === true) {
    if (scoringCategory !== "selection") {
      issues.push({ path: `${path}.scoringCategory`, message: 'supported cases require scoringCategory "selection"' });
    }
    if (invalidFillPhase !== "none") {
      issues.push({ path: `${path}.invalidFillPhase`, message: 'supported cases require invalidFillPhase "none"' });
    }
  } else if (v.supported === false && isSelection) {
    issues.push({ path: `${path}.scoringCategory`, message: 'a non-supported case cannot use scoringCategory "selection"' });
  }
  if (scoringCategory === "malformed_input" && invalidFillPhase === "none") {
    issues.push({ path: `${path}.invalidFillPhase`, message: 'scoringCategory "malformed_input" requires a non-"none" invalidFillPhase' });
  }
  if (v.evidenceLevel === "physical" && (typeof v.expectedObservation !== "string" || v.expectedObservation.length === 0)) {
    issues.push({ path: `${path}.expectedObservation`, message: 'evidenceLevel "physical" requires a non-empty expectedObservation' });
  }

  if (issues.length > 0 || selected === null || expectedOutcome === null) {
    return { case: null, issues };
  }

  return {
    case: {
      schemaVersion: 1,
      id: v.id as string,
      selected,
      supported: v.supported as boolean,
      utterance: v.utterance as string,
      fixtureSha256: v.fixtureSha256 as string,
      initialStateSha256: v.initialStateSha256 as string,
      expectedOutcome,
      finalStatePredicates: v.finalStatePredicates as EvalCaseV1["finalStatePredicates"],
      prohibitedEffects: v.prohibitedEffects as string[],
      evidenceLevel: v.evidenceLevel as EvalCaseV1["evidenceLevel"],
      scoringCategory: scoringCategory as EvalCaseV1["scoringCategory"],
      invalidFillPhase: invalidFillPhase as EvalCaseV1["invalidFillPhase"],
      expectedObservation: v.expectedObservation as string | undefined,
    },
    issues: [],
  };
}

/** Strict LF-terminated JSONL, bounded to 512 cases / 4 MiB, unique IDs, full shape validation. */
export function parseEvalCasesV1(bytes: Uint8Array): ParseEvalCasesResultV1 {
  if (bytes.length > FOUNDRY_STORAGE_LIMITS_V1.maxEvalsJsonlBytes) {
    return { ok: false, issues: [{ path: "$", message: `exceeds ${FOUNDRY_STORAGE_LIMITS_V1.maxEvalsJsonlBytes} bytes` }] };
  }
  if (bytes.length === 0) {
    return { ok: false, issues: [{ path: "$", message: "evals.jsonl must not be empty" }] };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, issues: [{ path: "$", message: "not valid UTF-8" }] };
  }
  if (!text.endsWith("\n")) {
    return { ok: false, issues: [{ path: "$", message: "must end with a trailing newline" }] };
  }

  const lines = text.slice(0, -1).split("\n");
  if (lines.length > FOUNDRY_STORAGE_LIMITS_V1.maxEvalCases) {
    return { ok: false, issues: [{ path: "$", message: `exceeds ${FOUNDRY_STORAGE_LIMITS_V1.maxEvalCases} cases` }] };
  }

  const cases: EvalCaseV1[] = [];
  const allIssues: ParseIssueV1[] = [];
  const seenIds = new Set<string>();

  lines.forEach((line, index) => {
    if (line.length === 0) {
      allIssues.push({ path: `line ${index + 1}`, message: "blank line" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      allIssues.push({ path: `line ${index + 1}`, message: "not valid JSON" });
      return;
    }
    const { case: parsedCase, issues } = validateOneCase(parsed, index + 1, seenIds);
    allIssues.push(...issues);
    if (parsedCase !== null) {
      seenIds.add(parsedCase.id);
      cases.push(parsedCase);
    }
  });

  if (allIssues.length > 0) return { ok: false, issues: allIssues };
  return { ok: true, value: cases };
}
