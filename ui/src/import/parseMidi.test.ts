import { describe, it, expect } from "vitest";
import { parseMidi } from "./parseMidi";

// Build a minimal Standard MIDI File from byte arrays.
const mthd = (format: number, ntrks: number, ppq: number) => [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, ntrks, (ppq >> 8) & 0xff, ppq & 0xff];
const mtrk = (bytes: number[]) => [0x4d, 0x54, 0x72, 0x6b, (bytes.length >> 24) & 0xff, (bytes.length >> 16) & 0xff, (bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes];

describe("parseMidi", () => {
  it("parses tempo, time signature, and paired notes (beats) from a format-1 file", () => {
    const meta = mtrk([
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo 500000us = 120 BPM
      0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const notes = mtrk([
      0x00, 0x90, 0x3c, 0x64, // note-on ch0 pitch60 vel100 @ tick0
      0x83, 0x60, 0x80, 0x3c, 0x40, // +480 ticks note-off pitch60  → 1 beat long
      0x00, 0x90, 0x40, 0x64, // note-on pitch64 @ tick480
      0x81, 0x70, 0x80, 0x40, 0x40, // +240 ticks note-off pitch64 → start beat1, len 0.5
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const buf = Buffer.from([...mthd(1, 2, 480), ...meta, ...notes]);
    const ir = parseMidi(buf, "x.mid");

    expect(ir.session.tempo).toBe(120);
    expect(ir.session.timeSig).toEqual({ numerator: 4, denominator: 4 });
    expect(ir.session.tracks).toHaveLength(1);
    const clip = ir.session.tracks[0].clips[0];
    expect(clip.kind).toBe("midi");
    expect(clip.notes).toHaveLength(2);
    expect(clip.notes![0]).toMatchObject({ pitch: 60, start: 0, length: 1, velocity: 100 });
    expect(clip.notes![1]).toMatchObject({ pitch: 64, start: 1, length: 0.5 });
  });

  it("maps GM channel 10 (index 9) to a drum track", () => {
    const trk = mtrk([
      0x00, 0x99, 0x24, 0x64, // note-on ch9 pitch36 (kick)
      0x83, 0x60, 0x89, 0x24, 0x40, // note-off
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const ir = parseMidi(Buffer.from([...mthd(0, 1, 480), ...trk]), "d.mid");
    expect(ir.session.tracks).toHaveLength(1);
    expect(ir.session.tracks[0].type).toBe("drum");
    expect(ir.session.tracks[0].clips[0].notes![0].pitch).toBe(36);
  });

  it("splits multiple channels in one track into separate IRTracks", () => {
    const trk = mtrk([
      0x00, 0x90, 0x3c, 0x64, 0x83, 0x60, 0x80, 0x3c, 0x40, // ch0 note
      0x00, 0x91, 0x30, 0x64, 0x83, 0x60, 0x81, 0x30, 0x40, // ch1 note
      0x00, 0xff, 0x2f, 0x00,
    ]);
    const ir = parseMidi(Buffer.from([...mthd(0, 1, 480), ...trk]), "m.mid");
    expect(ir.session.tracks.length).toBe(2);
  });

  it("defaults tempo to 120 and flags non-MIDI / empty input", () => {
    expect(parseMidi(Buffer.from([1, 2, 3]), "bad").unmappable[0]).toMatch(/not a Standard MIDI File/);
    const noNotes = parseMidi(Buffer.from([...mthd(0, 1, 480), ...mtrk([0x00, 0xff, 0x2f, 0x00])]), "e.mid");
    expect(noNotes.session.tempo).toBe(120);
    expect(noNotes.unmappable.some((u) => /no note tracks/.test(u))).toBe(true);
  });
});
