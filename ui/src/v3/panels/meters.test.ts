import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  METER_FLASH_MS, meterEventsOf, meterFrameKey, takeNewMeterEvents, useMeterEvents, type MeterFlash,
} from "./meters";
import type { FourOscMeter, PluginMeterReading, SamplerMeter } from "../../types";

const synth = (seq: number | undefined, struck: number[], held: number[] = struck): FourOscMeter => ({
  trackId: "t1", index: 0, itemId: "i1", type: "4osc", outDb: -12, held, struck, ...(seq === undefined ? {} : { seq }),
});
const sampler = (seq: number, hits: { note: number; vel: number }[]): SamplerMeter => ({
  trackId: "t1", index: 0, itemId: "i2", type: "sampler", outDb: -9, held: [], hits, seq,
});

describe("meter events (pure)", () => {
  it("normalises struck (no velocity) and hits (largest velocity per note), dropping junk", () => {
    expect(meterEventsOf(synth(1, [60, 64]), "struck")).toEqual([{ note: 60, vel: 1 }, { note: 64, vel: 1 }]);
    expect(meterEventsOf(sampler(1, [{ note: 36, vel: 0.5 }, { note: 36, vel: 0.9 }, { note: 38, vel: 2 }]), "hits"))
      .toEqual([{ note: 36, vel: 0.9 }, { note: 38, vel: 1 }]);
    const junk = { ...sampler(1, []), hits: [{ note: -1, vel: 1 }, { note: 1.5, vel: 1 }, { vel: 1 }, null] } as unknown as PluginMeterReading;
    expect(meterEventsOf(junk, "hits")).toEqual([]);
    expect(meterEventsOf(undefined, "hits")).toEqual([]);
    expect(meterEventsOf(synth(1, [60]), "hits")).toEqual([]);        // the field the frame does not have
  });

  it("a new seq fires, the same seq (a held frame) never does", () => {
    const f1 = synth(7, [60]);
    const a = takeNewMeterEvents(undefined, f1, "struck");
    expect(a.events).toEqual([{ note: 60, vel: 1 }]);
    // the same frame object, or a copy with the same seq (a re-render of a held frame)
    expect(takeNewMeterEvents(a.key, f1, "struck").events).toEqual([]);
    expect(takeNewMeterEvents(a.key, { ...f1 }, "struck").events).toEqual([]);
    // the next frame strikes the same key again: that is a second strike
    const b = takeNewMeterEvents(a.key, synth(8, [60]), "struck");
    expect(b.events).toEqual([{ note: 60, vel: 1 }]);
    // no frame: nothing, and the last key is kept (the frame coming back is not new)
    expect(takeNewMeterEvents(b.key, undefined, "struck")).toEqual({ key: b.key, events: [] });
    expect(takeNewMeterEvents(b.key, synth(8, [60]), "struck").events).toEqual([]);
  });

  it("an engine without seq: each payload's new object is a new frame", () => {
    const f = synth(undefined, [48]);
    expect(meterFrameKey(f)).toBe(f);
    const a = takeNewMeterEvents(undefined, f, "struck");
    expect(a.events).toHaveLength(1);
    expect(takeNewMeterEvents(a.key, f, "struck").events).toEqual([]);
    expect(takeNewMeterEvents(a.key, synth(undefined, [48]), "struck").events).toHaveLength(1);
  });
});

describe("useMeterEvents", () => {
  let host: HTMLDivElement;
  let root: Root;
  let seen: ReadonlyMap<number, MeterFlash>[];
  function Probe({ reading, field }: { reading: PluginMeterReading | undefined; field: "struck" | "hits" }) {
    seen.push(useMeterEvents(reading, field));
    return null;
  }
  const render = (reading: PluginMeterReading | undefined, field: "struck" | "hits" = "hits") =>
    act(() => root.render(React.createElement(Probe, { reading, field })));
  const last = () => seen[seen.length - 1]!;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    seen = [];
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("lights each hit once, keeps it for the flash, then clears it by itself", () => {
    render(sampler(1, [{ note: 36, vel: 0.8 }]));
    expect([...last().keys()]).toEqual([36]);
    expect(last().get(36)).toMatchObject({ vel: 0.8, serial: 1 });
    // re-rendering the SAME held frame does not re-fire (the serial stays)
    act(() => { vi.advanceTimersByTime(50); });
    render(sampler(1, [{ note: 36, vel: 0.8 }]));
    expect(last().get(36)?.serial).toBe(1);
    // after the flash time it is gone, without any new frame
    act(() => { vi.advanceTimersByTime(METER_FLASH_MS); });
    expect(last().size).toBe(0);
    // and the held frame still does not bring it back
    render(sampler(1, [{ note: 36, vel: 0.8 }]));
    expect(last().size).toBe(0);
  });

  it("a hit in the next frame fires again (new serial), and other notes join", () => {
    render(sampler(10, [{ note: 38, vel: 1 }]));
    render(sampler(11, [{ note: 38, vel: 0.5 }, { note: 42, vel: 0.4 }]));
    expect(last().get(38)).toMatchObject({ serial: 2, vel: 0.5 });
    expect(last().get(42)).toMatchObject({ serial: 2, vel: 0.4 });
    // a frame without events changes nothing that is lit
    render(sampler(12, []));
    expect([...last().keys()].sort()).toEqual([38, 42]);
  });

  it("a note struck again just as its old flash expires stays lit (new serial), and returned maps are never mutated", () => {
    render(sampler(20, [{ note: 36, vel: 1 }]));
    const first = last();
    act(() => { vi.advanceTimersByTime(METER_FLASH_MS); });
    render(sampler(21, [{ note: 36, vel: 0.6 }]));
    expect(last().get(36)).toMatchObject({ serial: 2, vel: 0.6 });
    expect(first.get(36)).toMatchObject({ serial: 1, vel: 1 });     // the earlier result is untouched
    expect(first).not.toBe(last());
  });

  it("4OSC struck keys work the same way; the frame going away does not clear a live flash early", () => {
    render(synth(3, [60, 67]), "struck");
    expect([...last().keys()]).toEqual([60, 67]);
    render(undefined, "struck");
    expect([...last().keys()]).toEqual([60, 67]);
    act(() => { vi.advanceTimersByTime(METER_FLASH_MS + 5); });
    expect(last().size).toBe(0);
  });
});
