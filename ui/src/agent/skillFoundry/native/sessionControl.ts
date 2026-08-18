// Skill Foundry Slice B, Task 3 — the native `session-control` handler (canonical id
// "session-control", handlerKey "sessionControlV1").
//
// Owns six EXPLICIT, non-toggle actions: play, stop, from_start, save, undo, redo. Every
// action is a bounded, honestly-reported transport/history operation with NO atomicity
// claim (spec 8.5's "lifecycle" posture, not "atomic") — outcomes always carry
// `changes: null`, exactly like takeCycleV1. This module does its OWN anchored-phrase
// utterance matching (spec 2.1: "session control ... no creative interpretation") rather
// than depending on a slot the runtime pre-fills, because the six actions ARE the whole
// vocabulary — there is no slot value beyond which literal phrase was said.
//
// `runSessionControlV1(utterance, environment)` is the primary, directly-testable entry
// point (no `payload` needed — every outcome uses the module's own fixed skill identity
// unless a caller supplies one); `sessionControlV1: NativeSkillHandlerV1` is the thin
// wrapper the runtime's closed handler map actually holds, forwarding the resolved
// native payload's own id/version so a version bump never has to touch this file twice.

import type {
  NativeSkillHandlerV1,
  RecordingLifecycleResultV1,
  SkillOutcomeV1,
  SkillReasonCodeV1,
  StudioSkillEnvironmentV1,
} from "../contracts";

export type SessionControlActionV1 = "play" | "stop" | "from_start" | "save" | "undo" | "redo";

export type SessionControlIdentityV1 = { readonly skill: string; readonly version: string };

const DEFAULT_IDENTITY: SessionControlIdentityV1 = { skill: "session-control", version: "1.0.0" };

// Anchored (full-utterance) phrase patterns per action. Deliberately whole-string
// matches (never `.includes`/substring) so "play the drums louder" — a different,
// unrelated ask — never mismatches into a bare transport toggle. Several synonym
// phrasings per action so a held-out paraphrase still resolves deterministically.
const PHRASES: readonly { readonly action: SessionControlActionV1; readonly patterns: readonly RegExp[] }[] = [
  {
    action: "play",
    patterns: [/^play$/i, /^play it$/i, /^hit play$/i, /^start playback$/i, /^start playing$/i],
  },
  {
    action: "stop",
    patterns: [/^stop$/i, /^stop it$/i, /^stop playback$/i, /^pause$/i, /^pause playback$/i],
  },
  {
    action: "from_start",
    patterns: [
      /^(go |jump )?(back )?to (the )?(start|beginning)$/i,
      /^from (the )?(start|top)$/i,
      /^rewind( to (the )?start)?$/i,
      /^back to (the )?start$/i,
    ],
  },
  {
    action: "save",
    patterns: [/^save$/i, /^save it$/i, /^save (the )?(project|session)$/i],
  },
  {
    action: "undo",
    patterns: [/^undo$/i, /^undo that$/i, /^undo (the )?last (change|action)$/i],
  },
  {
    action: "redo",
    patterns: [/^redo$/i, /^redo that$/i, /^redo (the )?last (change|action|undo)$/i],
  },
];

export function matchSessionControlActionV1(utterance: string): SessionControlActionV1 | null {
  const trimmed = utterance.trim();
  if (trimmed.length === 0) return null;
  for (const { action, patterns } of PHRASES) {
    if (patterns.some((pattern) => pattern.test(trimmed))) return action;
  }
  return null;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completed(identity: SessionControlIdentityV1, say: string): SkillOutcomeV1 {
  return { kind: "completed", skill: identity.skill, version: identity.version, say, changes: null };
}

function blocked(identity: SessionControlIdentityV1, code: SkillReasonCodeV1, say: string): SkillOutcomeV1 {
  return { kind: "blocked", skill: identity.skill, version: identity.version, code, say, unserved: true };
}

function fromLifecycle(identity: SessionControlIdentityV1, result: RecordingLifecycleResultV1): SkillOutcomeV1 {
  if (result.ok) return completed(identity, result.say);
  return blocked(identity, result.code, result.say);
}

// ---------------------------------------------------------------------------------------
// Per-action runners
// ---------------------------------------------------------------------------------------

async function runPlay(identity: SessionControlIdentityV1, environment: StudioSkillEnvironmentV1): Promise<SkillOutcomeV1> {
  let snapshot;
  try {
    snapshot = await environment.snapshot();
  } catch (error) {
    return blocked(identity, "observation_failed", `Could not read session state: ${detail(error)}.`);
  }
  if (snapshot.transport.playing) return completed(identity, "Already playing.");

  let result;
  try {
    result = await environment.exec("set_transport", { action: "play" });
  } catch (error) {
    return blocked(identity, "command_failed", `Could not start playback: ${detail(error)}.`);
  }
  if (!result.ok) return blocked(identity, "command_failed", result.error ?? "Could not start playback.");
  return completed(identity, "Playing.");
}

async function runStop(identity: SessionControlIdentityV1, environment: StudioSkillEnvironmentV1): Promise<SkillOutcomeV1> {
  let snapshot;
  try {
    snapshot = await environment.snapshot();
  } catch (error) {
    return blocked(identity, "observation_failed", `Could not read session state: ${detail(error)}.`);
  }

  // Recording-aware Stop: while recording, Stop must land the take (the SAME lifecycle
  // seam takeCycleV1's own `stop` action uses), never a bare transport stop that leaves
  // the recording dangling.
  if (snapshot.transport.recording) {
    let result: RecordingLifecycleResultV1;
    try {
      result = await environment.recording.stop();
    } catch (error) {
      return blocked(identity, "observation_failed", `Could not stop recording: ${detail(error)}.`);
    }
    return fromLifecycle(identity, result);
  }

  if (!snapshot.transport.playing) return completed(identity, "Already stopped.");

  let result;
  try {
    result = await environment.exec("set_transport", { action: "stop" });
  } catch (error) {
    return blocked(identity, "command_failed", `Could not stop playback: ${detail(error)}.`);
  }
  if (!result.ok) return blocked(identity, "command_failed", result.error ?? "Could not stop playback.");
  return completed(identity, "Stopped.");
}

async function runFromStart(identity: SessionControlIdentityV1, environment: StudioSkillEnvironmentV1): Promise<SkillOutcomeV1> {
  let snapshot;
  try {
    snapshot = await environment.snapshot();
  } catch (error) {
    return blocked(identity, "observation_failed", `Could not read session state: ${detail(error)}.`);
  }
  if (snapshot.transport.position === 0) return completed(identity, "Already at the start.");

  let result;
  try {
    result = await environment.exec("set_transport", { action: "to_start" });
  } catch (error) {
    return blocked(identity, "command_failed", `Could not return to the start: ${detail(error)}.`);
  }
  if (!result.ok) return blocked(identity, "command_failed", result.error ?? "Could not return to the start.");
  return completed(identity, "Back to the start.");
}

async function runSave(identity: SessionControlIdentityV1, environment: StudioSkillEnvironmentV1): Promise<SkillOutcomeV1> {
  let result;
  try {
    result = await environment.exec("save", {});
  } catch (error) {
    return blocked(identity, "command_failed", `Could not save: ${detail(error)}.`);
  }
  if (!result.ok) return blocked(identity, "command_failed", result.error ?? "Could not save.");

  // Save completes only after a fresh observation shows the project is no longer dirty
  // — a "the command returned ok" alone is not honest completion evidence.
  try {
    await environment.refresh();
  } catch (error) {
    return blocked(identity, "observation_failed", `Could not verify the save: ${detail(error)}.`);
  }
  let snapshot;
  try {
    snapshot = await environment.snapshot();
  } catch (error) {
    return blocked(identity, "observation_failed", `Could not verify the save: ${detail(error)}.`);
  }
  if (snapshot.session.dirty === true) {
    return blocked(identity, "command_failed", "The project still shows unsaved changes after Save.");
  }
  return completed(identity, "Saved.");
}

async function runUndo(identity: SessionControlIdentityV1, environment: StudioSkillEnvironmentV1): Promise<SkillOutcomeV1> {
  let result;
  try {
    result = await environment.exec("undo", {});
  } catch (error) {
    return blocked(identity, "command_failed", `Could not undo: ${detail(error)}.`);
  }
  if (!result.ok) return blocked(identity, "command_failed", result.error ?? "Could not undo.");
  const applied = (result.data as { undone?: unknown } | undefined)?.undone === true;
  if (!applied) return blocked(identity, "command_failed", "Nothing to undo.");
  return completed(identity, "Undone.");
}

async function runRedo(identity: SessionControlIdentityV1, environment: StudioSkillEnvironmentV1): Promise<SkillOutcomeV1> {
  let result;
  try {
    result = await environment.exec("redo", {});
  } catch (error) {
    return blocked(identity, "command_failed", `Could not redo: ${detail(error)}.`);
  }
  if (!result.ok) return blocked(identity, "command_failed", result.error ?? "Could not redo.");
  const applied = (result.data as { redone?: unknown } | undefined)?.redone === true;
  if (!applied) return blocked(identity, "command_failed", "Nothing to redo.");
  return completed(identity, "Redone.");
}

// ---------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------

/**
 * Match `utterance` against the six anchored session-control phrases and run it. Returns
 * `null` — NOT a `SkillOutcomeV1` — when nothing matches, so a caller can fall through to
 * the next deterministic matcher rather than being forced to interpret an `unsupported`
 * outcome as "this module tried and failed" (the runtime, not this module, owns
 * `unsupported_intent` framing for a totally unmatched utterance — see runtime.ts).
 */
export async function runSessionControlV1(
  utterance: string,
  environment: StudioSkillEnvironmentV1,
  identity: SessionControlIdentityV1 = DEFAULT_IDENTITY,
): Promise<SkillOutcomeV1 | null> {
  const action = matchSessionControlActionV1(utterance);
  if (!action) return null;

  switch (action) {
    case "play": return runPlay(identity, environment);
    case "stop": return runStop(identity, environment);
    case "from_start": return runFromStart(identity, environment);
    case "save": return runSave(identity, environment);
    case "undo": return runUndo(identity, environment);
    case "redo": return runRedo(identity, environment);
  }
}

export const sessionControlV1: NativeSkillHandlerV1 = async ({ payload, environment, utterance }) => {
  const identity: SessionControlIdentityV1 = { skill: payload.id, version: payload.version };
  const outcome = await runSessionControlV1(utterance, environment, identity);
  if (outcome) return outcome;
  return blocked(identity, "unsupported_intent", payload.responses.blocked);
};
