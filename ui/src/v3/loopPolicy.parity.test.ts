import { describe, expect, it } from "vitest";
import { loopAvailable, loopActionTarget, LOOP_ACTIONS, type LoopAction } from "./loopPolicy";
import { available as padAvailable, actionTarget as padActionTarget } from "../phonepad/src/policy";
import type { PadContext } from "../phonepad/src/policy";
import type { Action, PartId, State } from "../phonepad/src/contract";
import type { LoopContribution, LoopState } from "../types";

// ONE TABLE, BOTH SURFACES. The Booth (ui/src/v3/loopPolicy.ts) is a port of the phone
// pad (ui/src/phonepad/src/policy.ts), and the whole promise of the pair is that a
// producer who learns one has learned the other: a button that is live on the phone is
// live on the Mac. Two hand-maintained copies of a nine-action availability rule drift
// silently — the symptom is a dark button in the live room, which nobody debugs while
// singing — so the rule is pinned by agreement rather than by two separate transcriptions
// of the same intent.
//
// THE MAPPING, and where it deliberately stops:
//   · `connected` / `hostAlive` are trivially true on the desktop (the Booth IS the host),
//     so the table holds them true and does not attempt to model a disconnected Booth.
//   · `blockReason` has NO pad counterpart: the pad renders it as text above its buttons.
//     The table therefore holds it empty, and loopPolicy.test.ts covers it separately.
//   · the pad's server-side `busy` has no desktop counterpart either; `pending` (a command
//     of ours in flight) is the field both sides really do share, and it IS in the table.
// Anything outside that mapping is not a parity claim and is not asserted here.

type Case = {
  readonly name: string;
  readonly engaged: boolean;
  readonly recording: boolean;
  readonly playing: boolean;
  readonly currentId: string | null;
  readonly lastId: string | null;
  readonly auditionedId: string | null;
  readonly parts: readonly string[];
  readonly selected: string | null;
  readonly pending: boolean;
};

const base: Case = {
  name: "engaged and idle", engaged: true, recording: false, playing: false,
  currentId: null, lastId: null, auditionedId: null, parts: [], selected: null, pending: false,
};
const withCase = (name: string, over: Partial<Case>): Case => ({ ...base, ...over, name });

const CASES: readonly Case[] = [
  base,
  withCase("not engaged", { engaged: false }),
  withCase("recording with a current pass", { recording: true, playing: true, currentId: "p1" }),
  withCase("recording with no current pass yet (count-in)", { recording: true, playing: true, currentId: null }),
  withCase("playing back", { playing: true }),
  withCase("stopped with one captured pass and nothing selected", { lastId: "p1", parts: ["p1"] }),
  withCase("stopped with one captured pass selected", { lastId: "p1", parts: ["p1"], selected: "p1" }),
  withCase("stopped with an auditioned fallback only", { auditionedId: "p2", parts: ["p1", "p2"] }),
  withCase("selection that is not a contribution", { parts: ["p1"], lastId: "p1", selected: "ghost" }),
  withCase("a command in flight", { pending: true, lastId: "p1", parts: ["p1"] }),
  withCase("a command in flight while recording", { pending: true, recording: true, playing: true, currentId: "p1" }),
  withCase("many passes, the middle one picked", {
    parts: ["p1", "p2", "p3"], lastId: "p3", auditionedId: "p1", selected: "p2",
  }),
];

const desktopLoop = (c: Case): LoopState => ({
  engaged: c.engaged,
  phase: c.recording ? "recording" : c.playing ? "playing" : "idle",
  transport: { recording: c.recording, playing: c.playing, positionSec: 0 },
  listening: { qn: 0, bar: 1, entryQn: null, leadQn: 8 },
  currentId: c.currentId,
  lastId: c.lastId,
  reviewId: null,
  auditionedId: c.auditionedId,
  contributions: c.parts.map((id): LoopContribution => ({ id, label: `Part ${id}`, keeper: false, rejected: false })),
  phoneConnected: false,
  phoneSeenMs: 0,
  blockReason: "",   // no pad counterpart — see the note above
});

const padState = (c: Case): State => ({
  version: 1,
  sessionId: "s1" as State["sessionId"],
  projectId: "p" as State["projectId"],
  authority: "a" as State["authority"],
  phase: c.recording ? "recording" : c.playing ? "playing" : "idle",
  engaged: c.engaged,
  hostAlive: true,     // the Booth IS the host
  busy: false,         // no desktop counterpart — `pending` is the shared field
  recording: c.recording,
  playing: c.playing,
  playbackScope: "arrangement",
  listening: { bar: 1, qn: 0, entryQn: null, leadQn: 8 },
  currentId: (c.currentId as PartId | null),
  lastId: (c.lastId as PartId | null),
  reviewId: null,
  auditionedId: (c.auditionedId as PartId | null),
  contributions: c.parts.map((id) => ({ id: id as PartId, label: `Part ${id}`, keeper: false, rejected: false })),
  receipts: [],
  error: "",
});

const padContext = (c: Case): PadContext => ({
  state: padState(c), connected: true, pending: c.pending, selected: c.selected as PartId | null,
});
const deskContext = (c: Case) => ({ loop: desktopLoop(c), selected: c.selected, pending: c.pending });

describe("Booth / phone-pad policy parity", () => {
  // Anti-vacuity for the table itself: a table whose every row answered the same way for
  // every action would pass this suite while proving nothing. Both surfaces must produce
  // at least one true AND one false for each action across the rows.
  it("exercises both verdicts for every action (the table is not degenerate)", () => {
    for (const action of LOOP_ACTIONS) {
      const verdicts = CASES.map((c) => loopAvailable(action, deskContext(c)));
      expect(verdicts, `${action} is never available in any case`).toContain(true);
      if (action !== "stop") {
        expect(verdicts, `${action} is available in every case`).toContain(false);
      }
    }
    // stop is unconditional on an engaged loop on BOTH sides, so its only false is the
    // un-engaged row — assert that rather than pretending it varies.
    const notEngaged = CASES.find((c) => !c.engaged)!;
    expect(loopAvailable("stop", deskContext(notEngaged))).toBe(false);
    expect(padAvailable("stop", padContext(notEngaged))).toBe(false);
  });

  it("agrees on availability for every action in every case", () => {
    for (const c of CASES) {
      for (const action of LOOP_ACTIONS) {
        const desk = loopAvailable(action, deskContext(c));
        const pad = padAvailable(action as Action, padContext(c));
        expect(desk, `${action} / ${c.name}: Booth ${desk} vs pad ${pad}`).toBe(pad);
      }
    }
  });

  it("agrees on the target the command carries", () => {
    for (const c of CASES) {
      for (const action of LOOP_ACTIONS) {
        const desk = loopActionTarget(action as LoopAction, deskContext(c));
        const pad = padActionTarget(action as Action, padContext(c));
        // The pad returns `undefined` from a `find` miss where the Booth normalises to
        // null; the CLAIM is "the same pass, or none", so compare on that.
        expect(desk ?? null, `${action} / ${c.name}`).toBe(pad ?? null);
      }
    }
  });

  it("covers the same action set on both sides", () => {
    // A pad action with no Booth pad, or vice versa, is the other way this pair drifts.
    const padActions: readonly Action[] = [
      "record", "keep", "again", "hear", "play_all", "stop", "navigate", "home", "lead_in",
    ];
    expect([...LOOP_ACTIONS].sort()).toEqual([...padActions].sort());
  });
});
