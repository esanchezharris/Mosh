// BH-store — store.ts lifecycle leaks (adversarial bug-hunt).
//
// Four confirmed leaks in the store, each a "set-but-never-cleared" map or a
// stale short-circuit:
//   (1) renderProgress entries were never removed → the "is rendering" boolean
//       (Object.keys(renderProgress).length > 0) stuck true forever after the
//       first render. The terminal `layer_status` (where a render resolves) is the
//       clear point.
//   (2) peaks were cached by clipId and never invalidated when a clip's source is
//       repointed in place (applyRenderInPlace / relink_clip keep the id but swap
//       sourceFile) → a re-imagined clip kept drawing the OLD waveform.
//   (3) qaByClip (judge score) was never pruned → a removed/reset/rejected render
//       layer kept showing a dead quality readout.
//   (4) lastError was set on failure but only ever cleared by enterRecord → a
//       transient command error stuck through every later success.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { useStore } from "./store";
import { __resetMockForTests } from "./bridge.mock";
import { EXPECTED_SNAPSHOT_SCHEMA, type Snapshot } from "./types";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// A minimal, self-contained snapshot (used by the peaks + lastError specs that
// drive the store directly rather than through the mock's seed edit).
function mkSnapshot(over?: Partial<Snapshot>, clipSource = "/mock/a.wav"): Snapshot {
  return {
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120, editFile: "/tmp/x.mosh", key: { tonic: "A", mode: "minor" } },
    tracks: [
      {
        id: "t1", index: 0, name: "Keys", type: "audio",
        clips: [{ id: "c1", name: "chords", type: "wave", start: 0, length: 4, offset: 0, sourceFile: clipSource, hasRenderLayer: false }],
      },
    ],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    ...over,
  };
}

const firstWaveClipId = () =>
  useStore.getState().snapshot!.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")!.id;

describe("store lifecycle leaks (BH-store)", () => {
  // The layer_status / snapshot_invalidated reducers live inside init()'s event
  // handler, so the render-lifecycle specs need it wired to the mock's event bus.
  beforeAll(() => { useStore.getState().init(); });
  beforeEach(() => {
    __resetMockForTests();
    useStore.setState({ renderProgress: {}, qaByClip: {}, peaks: {}, peaksSourceKey: {}, lastError: null });
  });
  afterEach(async () => { await flush(); }); // drain any event-driven refresh before the next spec

  // ── (1) renderProgress must clear when a render resolves ────────────────────
  it("clears renderProgress[clipId] when a render resolves (terminal layer_status)", async () => {
    await useStore.getState().refresh();
    const clipId = firstWaveClipId();
    await useStore.getState().exec("create_render_layer", { clipId, mode: "reimagine" });

    // Simulate the in-flight progress events the native backend streams.
    useStore.setState({ renderProgress: { [clipId]: 0.5 } });
    expect(Object.keys(useStore.getState().renderProgress).length).toBe(1);

    // render_layer resolves the render → the mock emits layer_status for this clip.
    await useStore.getState().exec("render_layer", { clipId });

    expect(useStore.getState().renderProgress[clipId]).toBeUndefined();
    expect(Object.keys(useStore.getState().renderProgress).length).toBe(0);
  });

  it("keeps an unrelated clip's renderProgress when a different clip resolves", async () => {
    await useStore.getState().refresh();
    const clipId = firstWaveClipId();
    await useStore.getState().exec("create_render_layer", { clipId, mode: "reimagine" });
    // A second, still-rendering clip must not be cleared by the first's resolution.
    useStore.setState({ renderProgress: { [clipId]: 0.5, "other-clip": 0.3 } });

    await useStore.getState().exec("render_layer", { clipId });

    expect(useStore.getState().renderProgress[clipId]).toBeUndefined();
    expect(useStore.getState().renderProgress["other-clip"]).toBe(0.3);
  });

  // ── (2) peaks must invalidate when the source is repointed in place ─────────
  it("re-fetches peaks when a clip is repointed in place (same id, new sourceFile)", async () => {
    useStore.setState({ snapshot: mkSnapshot(undefined, "/mock/a.wav"), peaks: {}, peaksSourceKey: {} });

    useStore.getState().ensurePeaks("c1");
    await flush();
    const first = useStore.getState().peaks["c1"];
    expect(first).toBeTruthy();
    expect(useStore.getState().peaksSourceKey["c1"]).toBe("/mock/a.wav");

    // Same source → cached: the peaks reference is stable (no re-fetch).
    useStore.getState().ensurePeaks("c1");
    await flush();
    expect(useStore.getState().peaks["c1"]).toBe(first);

    // Repoint in place: applyRenderInPlace / relink_clip keep the clip id but swap sourceFile.
    useStore.setState({ snapshot: mkSnapshot(undefined, "/mock/b.wav") });
    useStore.getState().ensurePeaks("c1");
    await flush();

    // A fresh fetch ran (makePeaks returns a new array each call), keyed on the new source.
    expect(useStore.getState().peaks["c1"]).not.toBe(first);
    expect(useStore.getState().peaksSourceKey["c1"]).toBe("/mock/b.wav");
  });

  // ── (3) qaByClip must be pruned when a render layer goes away / reverts ──────
  it("prunes qaByClip when a render layer is rejected (reverted to dirty)", async () => {
    await useStore.getState().refresh();
    const clipId = firstWaveClipId();
    await useStore.getState().exec("create_render_layer", { clipId, mode: "reimagine" });
    await useStore.getState().exec("render_layer", { clipId }); // emits layer_status → qaByClip set
    await useStore.getState().refresh();
    expect(useStore.getState().qaByClip[clipId]?.pq).toBe(5.1);

    await useStore.getState().exec("reject_render", { clipId });
    await useStore.getState().refresh();

    expect(useStore.getState().qaByClip[clipId]).toBeUndefined();
  });

  it("prunes qaByClip when a render layer is removed", async () => {
    await useStore.getState().refresh();
    const clipId = firstWaveClipId();
    await useStore.getState().exec("create_render_layer", { clipId, mode: "reimagine" });
    await useStore.getState().exec("render_layer", { clipId });
    await useStore.getState().refresh();
    expect(useStore.getState().qaByClip[clipId]?.pq).toBe(5.1);

    await useStore.getState().exec("remove_render_layer", { clipId });
    await useStore.getState().refresh();

    expect(useStore.getState().qaByClip[clipId]).toBeUndefined();
  });

  it("keeps qaByClip while the render stays live (ready)", async () => {
    await useStore.getState().refresh();
    const clipId = firstWaveClipId();
    await useStore.getState().exec("create_render_layer", { clipId, mode: "reimagine" });
    await useStore.getState().exec("render_layer", { clipId });
    await useStore.getState().refresh();
    // A live, accepted render keeps its quality readout.
    await useStore.getState().exec("accept_render", { clipId });
    await useStore.getState().refresh();
    expect(useStore.getState().qaByClip[clipId]?.pq).toBe(5.1);
  });

  // ── (4) lastError must clear on the next success ────────────────────────────
  it("clears a stale lastError on the next successful command", async () => {
    useStore.setState({ snapshot: null, lastError: null });

    const bad = await useStore.getState().exec("render_layer", { clipId: "does-not-exist" });
    expect(bad.ok).toBe(false);
    expect(useStore.getState().lastError).toBeTruthy();

    const good = await useStore.getState().exec("enable_all_meters", {});
    expect(good.ok).toBe(true);
    expect(useStore.getState().lastError).toBeNull();
  });

  it("preserves the version banner across a successful command (does not clobber it)", async () => {
    // Engine schema newer than this UI build → a soft version banner that must persist.
    useStore.setState({
      snapshot: mkSnapshot({ schemaVersion: EXPECTED_SNAPSHOT_SCHEMA + 1 }),
      lastError: "some transient command error",
    });

    const good = await useStore.getState().exec("enable_all_meters", {});
    expect(good.ok).toBe(true);
    expect(useStore.getState().lastError).toBe("This Mosh app is older than its engine. Please update the app.");
  });

  it("clears agent undo affordances before replacing the project", async () => {
    useStore.setState({
      agentChangeSet: {
        label: "load Serum 2",
        applied: 1,
        entries: [{ index: 0, command: "load_plugin", summary: "Added Serum 2", ok: true }],
      },
    });

    await useStore.getState().exec("new_project", {});

    expect(useStore.getState().agentChangeSet).toBeNull();
  });
});
