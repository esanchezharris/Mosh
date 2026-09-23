import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoothView } from "./BoothView";
import { useV3 } from "./shellState";
import { useStore } from "../store";
import type { CommandResult, LoopContribution, LoopState, Snapshot, Track } from "../types";

const track = (id: string, name: string, over: Partial<Track> = {}): Track =>
  ({ id, index: 0, name, type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [], ...over }) as unknown as Track;
const midiClip = (id: string) => ({ id, name: "beat", type: "midi", start: 0, length: 8, offset: 0 });
const waveClip = (id: string) => ({ id, name: "vox", type: "wave", start: 0, length: 8, offset: 0 });
const instrument = (name: string) => ({ index: 0, name, type: name.toLowerCase(), enabled: true, external: false, isInstrument: true, params: [] });
const effect = (name: string) => ({ index: 1, name, type: name.toLowerCase(), enabled: true, external: false, isInstrument: false, params: [] });
// What `+ Drum beat` leaves behind: a drum-typed track with a sampler and a MIDI clip, SELECTED.
const drums = (over: Partial<Track> = {}) =>
  track("21", "Drums", { type: "drum", isInstrument: true, clips: [midiClip("c21")] as Track["clips"], plugins: [instrument("Sampler")] as Track["plugins"], ...over });
const pairing = { host: "192.168.1.9", port: 8792, token: "ab".repeat(16), expiresAtMs: 0,
  pairingUrl: "mosh://pair", webUrl: "http://192.168.1.9:8792/web", padUrl: "http://192.168.1.9:8792/pad#token=abab" };

const part = (id: string, label: string, over: Partial<LoopContribution> = {}): LoopContribution =>
  ({ id, label, keeper: false, rejected: false, clipId: `c-${id}`, trackId: "11", ...over });

function loopState(over: Partial<LoopState> = {}): LoopState {
  return {
    engaged: true, phase: "idle", leadTrackId: "11", takesTrackId: "12",
    transport: { recording: false, playing: false, positionSec: 0 },
    listening: { qn: 8, bar: 3, entryQn: 8, leadQn: 4 },
    currentId: null, lastId: null, reviewId: null, auditionedId: null,
    contributions: [], phoneConnected: false, phoneSeenMs: 0, blockReason: "",
    ...over,
  };
}

function snapshotWith(tracks: Track[], loop?: LoopState): Snapshot {
  return {
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120, length: 16 },
    tracks,
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    ...(loop ? { loop } : {}),
  } as unknown as Snapshot;
}
function snapshot(loop?: LoopState, takesMonitor?: Track["monitor"]): Snapshot {
  return snapshotWith([
    track("11", "Keys"),
    track("12", "Keys · Takes", takesMonitor ? { monitor: takesMonitor } : {}),
  ], loop);
}

const PADS = ["v3-loop-record", "v3-loop-keep", "v3-loop-again", "v3-loop-hear", "v3-loop-play-all", "v3-loop-stop"];

describe("v3 Booth — the desktop recording pad", () => {
  let host: HTMLDivElement;
  let root: Root;
  const calls: { command: string; args?: Record<string, unknown> }[] = [];

  const render = (snap: Snapshot) => act(() => root.render(React.createElement(BoothView, { snapshot: snap })));
  const pad = (testId: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useV3.setState({ posture: "booth", phoneOpen: false });
    useStore.setState({
      snapshot: snapshot(),
      selectedTrackId: "11",
      remoteStatus: null,
      peaks: {},
      ensurePeaks: vi.fn(),
      refresh: vi.fn(async () => {}),
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        calls.push({ command, args });
        return { ok: true, command };
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useV3.setState({ posture: "studio" });
  });

  it("offers the selected track as Lead before the loop is engaged, and creates nothing on its own", async () => {
    render(snapshot());
    expect(host.querySelector('[data-testid="v3-booth"]')).not.toBeNull();
    expect(calls, "entering the Booth must not mutate the session").toEqual([]);
    for (const id of PADS) expect(pad(id), id).toBeNull();
    const setup = pad("v3-booth-setup");
    expect(setup).not.toBeNull();
    expect(setup!.textContent).toBe("Use Keys as Lead");
    await act(async () => { setup!.click(); });
    expect(calls).toEqual([{ command: "loop_setup", args: { trackId: "11" } }]);
  });

  it("renders the six pads with the policy's disabled states once engaged", () => {
    render(snapshot(loopState()));
    expect(pad("v3-booth-setup")).toBeNull();
    for (const id of PADS) expect(pad(id), id).not.toBeNull();
    // stopped, nothing recorded: record / play all / stop are live, the rest need a target
    expect(pad("v3-loop-record")!.disabled).toBe(false);
    expect(pad("v3-loop-play-all")!.disabled).toBe(false);
    expect(pad("v3-loop-stop")!.disabled).toBe(false);
    expect(pad("v3-loop-keep")!.disabled).toBe(true);
    expect(pad("v3-loop-again")!.disabled).toBe(true);
    expect(pad("v3-loop-hear")!.disabled).toBe(true);
    expect(pad("v3-loop-hear")!.textContent).toBe("Review Selected Take");

    render(snapshot(loopState({
      transport: { recording: true, playing: true, positionSec: 4 }, currentId: "p2",
      contributions: [part("p1", "Part 1")],
    })));
    expect(pad("v3-loop-record")!.disabled).toBe(true);
    expect(pad("v3-loop-keep")!.disabled).toBe(false);
    expect(pad("v3-loop-hear")!.disabled).toBe(false);
    expect(pad("v3-loop-hear")!.textContent).toBe("Review Current Recording");
    expect(pad("v3-loop-stop")!.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="v3-loop-go"]')!.disabled).toBe(true);
  });

  it("disables everything the Mac cannot do EXCEPT Stop, and says why", () => {
    render(snapshot(loopState({ blockReason: "No audio device — recording is unavailable on this Mac" })));
    // Stop stays live. blockReason can appear MID-TAKE (the interface unplugged, the
    // driver falling over) with the transport still rolling, and that is exactly the
    // moment the producer needs Stop. The phone pad has always worked this way.
    expect(pad("v3-loop-stop")!.disabled, "v3-loop-stop").toBe(false);
    for (const id of PADS.filter((p) => p !== "v3-loop-stop")) expect(pad(id)!.disabled, id).toBe(true);
    expect(host.textContent).toContain("No audio device");
  });

  it("Keep sends loop_keep with the target the readout names", async () => {
    render(snapshot(loopState({ lastId: "p1", contributions: [part("p1", "Part 1", { keeper: false })] })));
    expect(host.textContent).toContain("Target · Part 1 · preserved");
    await act(async () => { pad("v3-loop-keep")!.click(); });
    expect(calls).toEqual([{ command: "loop_keep", args: { targetId: "p1" } }]);
    expect(useStore.getState().refresh).toHaveBeenCalled();
  });

  it("shows the result's own detail — including a Keep that committed but did not roll again", async () => {
    useStore.setState({
      exec: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return { ok: true, command, data: { applied: true, restarted: false,
          detail: "Kept Part 1; recording did not restart: no audio device" } };
      }),
    });
    render(snapshot(loopState({ lastId: "p1", contributions: [part("p1", "Part 1")] })));
    expect(host.querySelector('[data-testid="v3-booth-note"]')).toBeNull();   // anti-vacuity baseline
    await act(async () => { pad("v3-loop-keep")!.click(); });
    const note = host.querySelector('[data-testid="v3-booth-note"]');
    expect(note!.getAttribute("role")).toBe("status");
    expect(note!.textContent).toBe("Kept Part 1; recording did not restart: no audio device");
  });

  it("lists the contributions, marks what happened to them, and selects on click", async () => {
    render(snapshot(loopState({
      lastId: "p2",
      contributions: [part("p1", "Part 1", { rejected: true }), part("p2", "Part 2", { keeper: true })],
    })));
    const parts = host.querySelectorAll<HTMLButtonElement>('[data-testid="v3-loop-part"]');
    expect(parts).toHaveLength(2);
    expect(parts[0]!.className).toContain("rejected");
    expect(parts[0]!.className).not.toContain("kept");
    expect(parts[1]!.className).toContain("kept");
    expect(parts[0]!.textContent).toContain("Part 1 · preserved redo");

    await act(async () => { parts[0]!.click(); });
    expect(host.textContent).toContain("Target · Part 1 · preserved redo");
    await act(async () => { pad("v3-loop-again")!.click(); });
    expect(calls).toEqual([{ command: "loop_again", args: { targetId: "p1" } }]);
  });

  it("locks the contribution list while a pass is recording", () => {
    render(snapshot(loopState({
      transport: { recording: true, playing: true, positionSec: 4 }, currentId: "p2",
      contributions: [part("p1", "Part 1")],
    })));
    expect(host.querySelector<HTMLButtonElement>('[data-testid="v3-loop-part"]')!.disabled).toBe(true);
  });

  it("opens the phone dialog and reads the listening cursor back", () => {
    useStore.setState({ remoteStatus: { running: true, port: 8792, pairing } });
    render(snapshot(loopState()));
    expect(host.textContent).toContain("bar 3");
    expect(host.textContent).toContain("Entry 8 qn");
    expect(host.textContent).toContain("Lead 4 qn");
    act(() => pad("v3-booth-phone")!.click());
    expect(useV3.getState().phoneOpen).toBe(true);
  });

  // A THROWN exec, not a {ok:false} one. `exec` rejects when the bridge itself fails — a
  // dead WebView channel, a native call that threw before it could build an envelope —
  // and the old run() only had try/finally, so the rejection escaped as an unhandled
  // promise rejection: `pending` cleared, no note appeared, and the pad just went quiet.
  // In the live room that is indistinguishable from a button that does nothing.
  it("shows the reason in the status line when the bridge throws, instead of going silent", async () => {
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => { rejections.push(event.reason); event.preventDefault(); };
    window.addEventListener("unhandledrejection", onRejection);
    try {
      useStore.setState({
        exec: vi.fn(async () => { throw new Error("the engine channel is closed"); }),
      });
      render(snapshot(loopState({ lastId: "p1", contributions: [part("p1", "Part 1")] })));
      await act(async () => { pad("v3-loop-keep")!.click(); });
      await act(async () => { await Promise.resolve(); });

      const note = host.querySelector('[data-testid="v3-booth-note"]');
      expect(note, "a thrown exec must still leave a visible note").not.toBeNull();
      expect(note!.getAttribute("role")).toBe("status");
      expect(note!.textContent).toContain("the engine channel is closed");
      // …and the pads come back: a throw must not strand `pending` true for ever.
      expect(pad("v3-loop-keep")!.disabled).toBe(false);
      expect(rejections, "the throw must be handled, not escape as an unhandled rejection").toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onRejection);
    }
  });

  // ── A15: the Lead is never a drum, MIDI or instrument track ───────────────────────────
  describe("Lead candidates", () => {
    const setupText = () => pad("v3-booth-setup")!.textContent;

    it("skips the selected Drums track (what `+ Drum beat` leaves selected) for the audio track", async () => {
      useStore.setState({ selectedTrackId: "21" });
      render(snapshotWith([drums(), track("22", "Vox")]));
      expect(setupText()).toBe("Use Vox as Lead");
      await act(async () => { pad("v3-booth-setup")!.click(); });
      expect(calls).toEqual([{ command: "loop_setup", args: { trackId: "22" } }]);
    });

    it.each([
      ["a drum-typed track", track("31", "Kit", { type: "drum" })],
      ["a midi-typed track", track("31", "Synth", { type: "midi" })],
      ["an audio track holding a MIDI clip", track("31", "Beat", { clips: [midiClip("c31")] as Track["clips"] })],
      ["an instrument track with no plugin rows (the mock's Bass)", track("31", "Bass", { isInstrument: true })],
      ["a track whose plugins include an instrument", track("31", "Pad", { plugins: [effect("EQ"), instrument("4OSC")] as Track["plugins"] })],
      ["a group track", track("31", "Group", { type: "group", isGroup: true })],
      ["a return track", track("31", "Reverb", { isReturn: true, returnBus: 1 })],
    ])("never offers %s", (_label, excluded) => {
      useStore.setState({ selectedTrackId: "31" });
      render(snapshotWith([excluded, track("32", "Vox", { clips: [waveClip("c32")] as Track["clips"] })]));
      expect(setupText()).toBe("Use Vox as Lead");
      render(snapshotWith([excluded]));
      expect(setupText()).toBe("Add a Vocal track");
    });

    it("never offers a leftover Takes track as the Lead", () => {
      useStore.setState({ selectedTrackId: "12" });
      render(snapshotWith([track("12", "Vox · Takes"), track("11", "Vox")], loopState({ engaged: false, takesTrackId: "12" })));
      expect(setupText()).toBe("Use Vox as Lead");
    });

    it("prefers the selected candidate, then an armed one, then the first", () => {
      const tracks = [drums(), track("41", "Keys"), track("42", "Vox", { armed: true })];
      useStore.setState({ selectedTrackId: "41" });
      render(snapshotWith(tracks));
      expect(setupText()).toBe("Use Keys as Lead");
      useStore.setState({ selectedTrackId: "21" });
      render(snapshotWith(tracks));
      expect(setupText()).toBe("Use Vox as Lead");
      useStore.setState({ selectedTrackId: null });
      render(snapshotWith([drums(), track("41", "Keys"), track("42", "Vox")]));
      expect(setupText()).toBe("Use Keys as Lead");
    });

    it("with no candidate, Add a Vocal track creates one and makes it the Lead", async () => {
      useStore.setState({
        selectedTrackId: "21",
        exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
          calls.push({ command, args });
          return command === "create_track"
            ? { ok: true, command, data: { trackId: "51", type: "audio", isInstrument: false } }
            : { ok: true, command };
        }),
      });
      render(snapshotWith([drums()]));
      expect(setupText()).toBe("Add a Vocal track");
      expect(pad("v3-booth-setup")!.disabled).toBe(false);
      await act(async () => { pad("v3-booth-setup")!.click(); });
      expect(calls).toEqual([
        { command: "create_track", args: { name: "Vocal" } },
        { command: "loop_setup", args: { trackId: "51" } },
      ]);
    });

    it("a failed create_track stops there and says why", async () => {
      useStore.setState({
        exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
          calls.push({ command, args });
          return { ok: false, command, error: "insert failed" };
        }),
      });
      render(snapshotWith([]));
      expect(setupText()).toBe("Add a Vocal track");
      await act(async () => { pad("v3-booth-setup")!.click(); });
      expect(calls.map((c) => c.command)).toEqual(["create_track"]);
      expect(host.querySelector('[data-testid="v3-booth-note"]')!.textContent).toContain("insert failed");
    });
  });

  // ── A14: Hear myself — read from the snapshot, written through set_input_monitor ─────
  describe("Hear myself", () => {
    const monitor = () => pad("v3-booth-monitor");

    it("is not offered before the loop is set up", () => {
      render(snapshot());
      expect(monitor()).toBeNull();
    });

    it("reads the takes track's monitor mode and turns it off", async () => {
      render(snapshot(loopState(), "automatic"));
      expect(monitor()!.textContent).toBe("Hear myself: On");
      expect(monitor()!.getAttribute("aria-pressed")).toBe("true");
      expect(monitor()!.title).toBe("Monitoring applies to the whole input device");
      await act(async () => { monitor()!.click(); });
      expect(calls).toEqual([{ command: "set_input_monitor", args: { trackId: "12", mode: "off" } }]);
    });

    it("turns it back to automatic from off", async () => {
      render(snapshot(loopState(), "off"));
      expect(monitor()!.textContent).toBe("Hear myself: Off");
      expect(monitor()!.getAttribute("aria-pressed")).toBe("false");
      await act(async () => { monitor()!.click(); });
      expect(calls).toEqual([{ command: "set_input_monitor", args: { trackId: "12", mode: "automatic" } }]);
    });

    it("treats 'on' as on", () => {
      render(snapshot(loopState(), "on"));
      expect(monitor()!.textContent).toBe("Hear myself: On");
    });

    it("never flips on its own: the label follows the SNAPSHOT, not the click", async () => {
      render(snapshot(loopState(), "automatic"));
      await act(async () => { monitor()!.click(); });
      render(snapshot(loopState(), "automatic"));          // the engine did not change it
      expect(monitor()!.textContent).toBe("Hear myself: On");
      render(snapshot(loopState(), "off"));                // the engine did
      expect(monitor()!.textContent).toBe("Hear myself: Off");
    });

    it("says why when the engine could not apply it", async () => {
      useStore.setState({
        exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
          calls.push({ command, args });
          return { ok: true, command, data: { trackId: "12", mode: "off", applied: false, reason: "no input device" } };
        }),
      });
      render(snapshot(loopState(), "automatic"));
      await act(async () => { monitor()!.click(); });
      expect(host.querySelector('[data-testid="v3-booth-note"]')!.textContent).toContain("no input device");
    });
  });

  // ── A22: engineering readouts and the Phone button stay out of the way ────────────────
  describe("progressive disclosure", () => {
    it("keeps the readout and the lead-in / go-to-bar forms in a collapsed Details", () => {
      render(snapshot(loopState()));
      const details = host.querySelector<HTMLDetailsElement>('[data-testid="v3-booth-details"]');
      expect(details).not.toBeNull();
      expect(details!.tagName).toBe("DETAILS");
      expect(details!.open).toBe(false);
      expect(details!.querySelector("summary")!.textContent).toBe("Details");
      for (const id of ["v3-loop-target", "v3-loop-home", "v3-loop-bar", "v3-loop-go", "v3-loop-lead", "v3-loop-set-lead"])
        expect(details!.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
      expect(details!.textContent).toContain("Entry 8 qn");
      // …and none of it is outside the Details
      const outside = host.cloneNode(true) as HTMLElement;
      outside.querySelector('[data-testid="v3-booth-details"]')!.remove();
      expect(outside.textContent).not.toContain("Lead-in qn");
      expect(outside.textContent).not.toContain("Go to bar");
      expect(outside.textContent).not.toContain("Entry");
      // the pads themselves are NOT hidden
      expect(details!.querySelector('[data-testid="v3-loop-record"]')).toBeNull();
      expect(pad("v3-loop-record")).not.toBeNull();
    });

    it("shows the Phone button only once a phone is paired or connected", () => {
      render(snapshot(loopState()));
      expect(pad("v3-booth-phone")).toBeNull();
      useStore.setState({ remoteStatus: { running: true, port: 8792, pairing } });
      render(snapshot(loopState()));
      expect(pad("v3-booth-phone")).not.toBeNull();
      useStore.setState({ remoteStatus: null });
      render(snapshot(loopState({ phoneConnected: true })));
      expect(pad("v3-booth-phone")).not.toBeNull();
    });
  });

  it("no longer drives the old take lane", () => {
    render(snapshot(loopState({ contributions: [part("p1", "Part 1")] })));
    expect(host.querySelector('[data-testid="v3-takes"]')).toBeNull();
    expect(host.querySelector('[data-testid="v3-take"]')).toBeNull();
    expect(host.querySelector('[data-testid="v3-booth-record"]')).toBeNull();
    expect(calls.some((c) => c.command === "list_takes")).toBe(false);
  });
});
