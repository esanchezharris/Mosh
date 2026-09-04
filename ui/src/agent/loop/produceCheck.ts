// produceCheck.ts — the machine-checkable half of the round-2 correction
// (docs/produce-corrections/produce-r1-2026-09-02.meta.json: the owner's first
// ear verdict on the produce lane, all 7 candidates rated "fail"). producePrompt.ts
// v3 ASKS the model to follow the harmony/B-section/pad-coverage rules; this module
// re-derives the same facts from what the model actually WROTE (its add_midi_clip
// notes), so a driver can catch a violation and issue one targeted repair step
// before a run is ever called done. Pure — no I/O, no exec, no randomness — so it
// can run against a fixture (a real run's brain-replies.jsonl) or the live loop's
// in-memory notes with the exact same function.
//
// Rule provenance mirrors producePrompt.ts: every check here answers a specific
// note from the round-1 verdict.
// lesson: produce-corrections/produce-r1-2026-09-02 note 1  (harmony_clash)
// lesson: produce-corrections/produce-r1-2026-09-02 note 3  (stops_early, b_thin)
// lesson: produce-corrections/produce-r1-2026-09-02 note 6  (few_pads)

export type CheckNote = { pitch: number; start: number; length: number; velocity?: number };

export type CheckInput = {
  key: { tonic: string; mode: string };
  /** trackId -> role, e.g. "drums" | "808" | "lead" | "chords_pad" | "drone" |
   *  "counter" | "arp" | "ambient" | "stab" (matches produceTemplate.ts's SynthRole
   *  plus "drums"/"808" for the two non-synth tracks). */
  roles: Record<string, string>;
  /** trackId -> the notes actually written onto that track's one clip, in BEATS
   *  (MoshOps.Clips.cpp's note units — the same units PRODUCE_RULES asks for). */
  tracks: Record<string, CheckNote[]>;
  /** The drum pad notes the preflight laid (drumPalette.ts's DEFAULT_PADS
   *  shape) — defaults to the standard 10-pad map when omitted. */
  pads?: number[];
  /** Total bars in the arrangement; defaults to 8 (32 beats, A 0-16 + B 16-32). */
  bars?: number;
};

export type CheckProblem = {
  code: "harmony_clash" | "stops_early" | "b_thin" | "few_pads" | "missing_clip";
  trackId?: string;
  detail: string;
  beat?: number;
};

export type CheckReport = { ok: boolean; problems: CheckProblem[]; summary: string };

// ── constants ─────────────────────────────────────────────────────────────────

/** drumPalette.ts's DEFAULT_PADS notes (kick/snare/snare2/clap/clap2/hat/openhat/
 *  perc/fx/roll) — the fixed 10-pad map the preflight assigns by default. Used
 *  only as a fallback when `input.pads` is omitted. */
const DEFAULT_PADS = [36, 37, 38, 39, 40, 41, 42, 43, 44, 46];

/** Roles the harmony check applies to — the melodic/harmonic tracks. Drums and
 *  808 are the rhythm/root, not judged against themselves; drone and ambient are
 *  deliberately loose beds (PRODUCE_RULES: "Drone holds whole-bar... Ambient
 *  stays sparse"), not held to strict chord-tone discipline. */
const HARMONY_ROLES = new Set(["chords_pad", "arp", "lead", "counter", "stab"]);

const HARMONY_CLASH_THRESHOLD = 0.15; // > 15% clashing notes trips the track
const STOPS_EARLY_BEAT = 28; // bars 5-8 must be as full as bars 1-4 (PRODUCE_RULES)
const B_THIN_MIN_NOTES = 4; // only tracks with a real B part are judged
const B_THIN_RATIO = 0.8; // B half must be >= 0.8x the A half's note count
const FEW_PADS_MIN = 7; // < 7 of 10 pads used trips

const NAME_TO_PC: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

// ── music theory (minimal — just enough to name a diatonic chord) ──────────────

/** The scale form(s) whose diatonic chords are ALL allowed at once, relative
 *  semitone offsets from the tonic. Minor keys allow both the natural minor 7th
 *  degree and the harmonic minor's raised 7th (PRODUCE_RULES's HARMONY rule:
 *  "D minor natural/harmonic: allow both 6th/7th degrees") — everything else
 *  (major, or an unrecognized mode) gets its single diatonic scale. */
function scaleForms(mode: string): number[][] {
  const m = mode.trim().toLowerCase();
  if (m === "major") return [[0, 2, 4, 5, 7, 9, 11]];
  const natural = [0, 2, 3, 5, 7, 8, 10];
  const harmonic = [0, 2, 3, 5, 7, 8, 11];
  return [natural, harmonic];
}

function tonicPc(tonic: string): number {
  const key = tonic.trim();
  const norm = key.length ? key[0]!.toUpperCase() + key.slice(1) : key;
  return NAME_TO_PC[norm] ?? NAME_TO_PC[key] ?? 0;
}

/** The chord-tone pitch classes (0-11) of the diatonic triad + 7th built on
 *  `rootPc`, unioned across every allowed scale form. Empty when `rootPc` isn't
 *  a diatonic scale tone in ANY form (a chromatic 808 root — rare, but then
 *  nothing can be judged a "clash" against it). */
function chordTonesForRoot(rootPc: number, tonic: number, forms: number[][]): Set<number> {
  const rel = ((rootPc - tonic) % 12 + 12) % 12;
  const tones = new Set<number>();
  for (const scale of forms) {
    const i = scale.indexOf(rel);
    if (i < 0) continue;
    for (const step of [0, 2, 4, 6]) {
      tones.add((scale[(i + step) % scale.length]! + tonic) % 12);
    }
  }
  return tones;
}

// ── note-level helpers ──────────────────────────────────────────────────────────

function activeAt(notes: readonly CheckNote[], beat: number): CheckNote[] {
  return notes.filter((n) => n.start <= beat && beat < n.start + n.length);
}

function endOf(notes: readonly CheckNote[]): number {
  return notes.reduce((max, n) => Math.max(max, n.start + n.length), 0);
}

// ── the check ────────────────────────────────────────────────────────────────

export function checkProduceRun(input: CheckInput): CheckReport {
  const bars = input.bars ?? 8;
  const totalBeats = bars * 4;
  const halfBeat = totalBeats / 2;
  const pads = input.pads ?? DEFAULT_PADS;
  const problems: CheckProblem[] = [];

  // (e) missing_clip — a role with no notes at all.
  for (const [trackId, role] of Object.entries(input.roles)) {
    const notes = input.tracks[trackId] ?? [];
    if (notes.length === 0) {
      problems.push({ trackId, code: "missing_clip", detail: `role "${role}" (track ${trackId}) has no clip/notes at all.` });
    }
  }

  // (b) stops_early — last note ends before beat 28 (only tracks that have notes).
  for (const [trackId, notes] of Object.entries(input.tracks)) {
    if (notes.length === 0) continue;
    const end = endOf(notes);
    if (end < STOPS_EARLY_BEAT) {
      const role = input.roles[trackId] ?? "?";
      problems.push({
        trackId,
        code: "stops_early",
        beat: end,
        detail: `"${role}" (track ${trackId}) stops at beat ${end.toFixed(2)}, before beat ${STOPS_EARLY_BEAT} — bars 5-8 must be as full as bars 1-4.`,
      });
    }
  }

  // (c) b_thin — B half (beats halfBeat..totalBeats) has < 0.8x the notes of A half.
  for (const [trackId, notes] of Object.entries(input.tracks)) {
    if (notes.length < B_THIN_MIN_NOTES) continue;
    const aCount = notes.filter((n) => n.start < halfBeat).length;
    const bCount = notes.filter((n) => n.start >= halfBeat).length;
    if (bCount < B_THIN_RATIO * aCount) {
      const role = input.roles[trackId] ?? "?";
      problems.push({
        trackId,
        code: "b_thin",
        detail: `"${role}" (track ${trackId}) B half has ${bCount} notes vs A half's ${aCount} — B must be at least as dense as A.`,
      });
    }
  }

  // (d) few_pads — drums track uses < 7 distinct pads.
  const drumsTrackId = Object.entries(input.roles).find(([, role]) => role === "drums")?.[0];
  if (drumsTrackId) {
    const drumNotes = input.tracks[drumsTrackId] ?? [];
    const padSet = new Set(pads);
    const used = new Set(drumNotes.map((n) => n.pitch).filter((p) => padSet.has(p)));
    if (used.size < FEW_PADS_MIN) {
      problems.push({
        trackId: drumsTrackId,
        code: "few_pads",
        detail: `Drums (track ${drumsTrackId}) use only ${used.size} of the ${padSet.size} pads (need >= ${FEW_PADS_MIN}) — used: [${[...used].sort((a, b) => a - b).join(",")}].`,
      });
    }
  }

  // (a) harmony_clash — every beat with a sounding 808 note, judge every other
  // melodic track's simultaneously-sounding notes against the diatonic chord
  // built on that 808 root.
  const bassTrackId = Object.entries(input.roles).find(([, role]) => role === "808")?.[0];
  if (bassTrackId) {
    const bassNotes = input.tracks[bassTrackId] ?? [];
    const tonic = tonicPc(input.key.tonic);
    const forms = scaleForms(input.key.mode);
    const totals = new Map<string, number>();
    const clashes = new Map<string, number>();
    const clashBeats = new Map<string, number[]>();

    for (let beat = 0; beat < totalBeats; beat++) {
      const activeBass = activeAt(bassNotes, beat);
      if (activeBass.length === 0) continue;
      const rootPc = ((activeBass[0]!.pitch % 12) + 12) % 12;
      const chordTones = chordTonesForRoot(rootPc, tonic, forms);
      if (chordTones.size === 0) continue; // chromatic 808 root — nothing to judge against

      for (const [trackId, role] of Object.entries(input.roles)) {
        if (!HARMONY_ROLES.has(role)) continue;
        const notes = input.tracks[trackId] ?? [];
        for (const n of activeAt(notes, beat)) {
          totals.set(trackId, (totals.get(trackId) ?? 0) + 1);
          const pc = ((n.pitch % 12) + 12) % 12;
          if (!chordTones.has(pc)) {
            clashes.set(trackId, (clashes.get(trackId) ?? 0) + 1);
            const beats = clashBeats.get(trackId) ?? [];
            beats.push(beat);
            clashBeats.set(trackId, beats);
          }
        }
      }
    }

    for (const [trackId, total] of totals) {
      const clash = clashes.get(trackId) ?? 0;
      const ratio = total > 0 ? clash / total : 0;
      if (ratio > HARMONY_CLASH_THRESHOLD) {
        const role = input.roles[trackId] ?? "?";
        const beats = (clashBeats.get(trackId) ?? []).slice(0, 3);
        problems.push({
          trackId,
          code: "harmony_clash",
          beat: beats[0],
          detail: `"${role}" (track ${trackId}) clashes with the sounding 808 root on ${clash}/${total} notes (${(ratio * 100).toFixed(0)}%) — first beats: ${beats.join(", ")}.`,
        });
      }
    }
  }

  const ok = problems.length === 0;
  const summary = ok
    ? "produceCheck: no problems found — harmony, section density, pad coverage and clip coverage all pass."
    : `produceCheck: ${problems.length} problem${problems.length === 1 ? "" : "s"} found across ${new Set(problems.map((p) => p.trackId)).size} track(s): ${[...new Set(problems.map((p) => p.code))].join(", ")}.`;

  return { ok, problems, summary };
}

// ── repair error text ────────────────────────────────────────────────────────

const MAX_REPAIR_ERROR_LEN = 1200;

/** Render a CheckReport as the failed-step error text the loop's repair-mode
 *  compile turn gets (loopPrompt.ts's repair contract expects one error string).
 *  Always <= 1200 chars and names the offending trackIds so the model knows
 *  exactly which clip to rewrite. */
export function renderCheckAsRepairError(report: CheckReport): string {
  if (report.ok) return "produceCheck: no problems found.";
  const header = "PRODUCE CHECK FAILED — fix these before status \"done\":";
  const lines = report.problems.map((p) => `- [${p.code}] track ${p.trackId ?? "?"}: ${p.detail}`);
  let text = [header, ...lines].join("\n");
  if (text.length > MAX_REPAIR_ERROR_LEN) {
    // Truncate to the header plus as many whole problem lines as fit, then a
    // count of what got cut — trackIds in the KEPT lines still name real tracks.
    const kept: string[] = [header];
    let used = header.length;
    let cut = 0;
    for (const line of lines) {
      const withSep = used + 1 + line.length;
      if (withSep > MAX_REPAIR_ERROR_LEN - 20) { cut++; continue; }
      kept.push(line);
      used = withSep;
    }
    if (cut > 0) kept.push(`(+${cut} more problem${cut === 1 ? "" : "s"}, truncated)`);
    text = kept.join("\n");
    if (text.length > MAX_REPAIR_ERROR_LEN) text = text.slice(0, MAX_REPAIR_ERROR_LEN);
  }
  return text;
}
