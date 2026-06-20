import { describe, it, expect } from "vitest";
import { parseAls } from "./parseAls";

// Minimal synthetic LiveSet mirroring Ableton 12's shape. parseAls accepts plain
// XML (gunzip is attempted first, then falls back to raw) so the test needs no gzip.
const ALS = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton><LiveSet>
  <MainTrack><DeviceChain><Mixer><Tempo><Manual Value="128"/></Tempo></Mixer></DeviceChain></MainTrack>
  <Tracks>
    <AudioTrack Id="0">
      <Name><EffectiveName Value="Drums"/></Name>
      <DeviceChain>
        <Mixer>
          <Speaker><Manual Value="true"/></Speaker>
          <Pan><Manual Value="0"/></Pan>
          <Volume><Manual Value="0.5"/></Volume>
        </Mixer>
        <MainSequencer><Sample><ArrangerAutomation><Events>
          <AudioClip Id="1" Time="0"><Name Value="loop"/><CurrentStart Value="0"/><CurrentEnd Value="8"/></AudioClip>
        </Events></ArrangerAutomation></Sample></MainSequencer>
      </DeviceChain>
    </AudioTrack>
    <MidiTrack Id="1">
      <Name><EffectiveName Value="Bass"/></Name>
      <DeviceChain><Mixer>
        <Speaker><Manual Value="false"/></Speaker>
        <Pan><Manual Value="-0.5"/></Pan>
        <Volume><Manual Value="1"/></Volume>
      </Mixer></DeviceChain>
    </MidiTrack>
    <ReturnTrack Id="2"><Name><EffectiveName Value="Reverb"/></Name></ReturnTrack>
  </Tracks>
</LiveSet></Ableton>`;

describe("parseAls", () => {
  it("extracts tempo from the LiveSet (deep Tempo>Manual)", () => {
    const ir = parseAls(Buffer.from(ALS), "demo.als");
    expect(ir.format).toBe("als");
    expect(ir.session.tempo).toBe(128);
  });

  it("extracts audio + midi tracks in id order, with name/volume/pan/mute", () => {
    const { session } = parseAls(Buffer.from(ALS), "demo.als");
    expect(session.tracks.map((t) => t.name)).toEqual(["Drums", "Bass"]);
    const drums = session.tracks[0];
    expect(drums.volumeDb).toBeCloseTo(-6.02, 1); // 20*log10(0.5)
    expect(drums.pan).toBe(0);
    expect(drums.mute).toBe(false); // Speaker=true → audible
    const bass = session.tracks[1];
    expect(bass.mute).toBe(true); // Speaker=false → muted
    expect(bass.pan).toBeCloseTo(-0.5, 5);
  });

  it("extracts an arrangement AudioClip with beat→seconds conversion", () => {
    const { session } = parseAls(Buffer.from(ALS), "demo.als");
    const clip = session.tracks[0].clips[0];
    expect(clip.kind).toBe("wave");
    expect(clip.start).toBe(0);
    expect(clip.length).toBeCloseTo((8 * 60) / 128, 5); // 3.75s at 128 BPM
    expect(clip.name).toBe("loop");
  });

  it("logs return/group tracks as unmappable rather than dropping them", () => {
    const ir = parseAls(Buffer.from(ALS), "demo.als");
    expect(ir.unmappable.some((u) => /return/i.test(u))).toBe(true);
  });
});

// A MIDI arrangement clip: Ableton groups notes by pitch under KeyTracks>KeyTrack
// (MidiKey Value = pitch) with MidiNoteEvent Time/Duration in BEATS (no conversion)
// and a float Velocity that we round+clamp to 1–127.
const ALS_MIDI = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton><LiveSet>
  <MainTrack><DeviceChain><Mixer><Tempo><Manual Value="120"/></Tempo></Mixer></DeviceChain></MainTrack>
  <Tracks>
    <MidiTrack Id="0">
      <Name><EffectiveName Value="Bass"/></Name>
      <DeviceChain><MainSequencer><ClipTimeable><ArrangerAutomation><Events>
        <MidiClip Id="1" Time="4">
          <CurrentStart Value="4"/><CurrentEnd Value="8"/><Name Value="bassline"/>
          <Notes><KeyTracks>
            <KeyTrack Id="0">
              <Notes>
                <MidiNoteEvent Time="0" Duration="1" Velocity="100" />
                <MidiNoteEvent Time="2" Duration="0.5" Velocity="80.6" />
              </Notes>
              <MidiKey Value="36" />
            </KeyTrack>
            <KeyTrack Id="1">
              <Notes>
                <MidiNoteEvent Time="1" Duration="0.25" Velocity="64" />
              </Notes>
              <MidiKey Value="48" />
            </KeyTrack>
          </KeyTracks></Notes>
        </MidiClip>
      </Events></ArrangerAutomation></ClipTimeable></MainSequencer></DeviceChain>
    </MidiTrack>
  </Tracks>
</LiveSet></Ableton>`;

describe("parseAls MIDI notes", () => {
  it("extracts notes grouped by KeyTrack pitch, in beats, velocity rounded+clamped", () => {
    const { session } = parseAls(Buffer.from(ALS_MIDI), "midi.als");
    const clip = session.tracks[0].clips[0];
    expect(clip.kind).toBe("midi");
    expect(clip.start).toBeCloseTo((4 * 60) / 120, 5); // 2s — clip position in seconds
    expect(clip.notes).toEqual([
      { pitch: 36, start: 0, length: 1, velocity: 100 },
      { pitch: 36, start: 2, length: 0.5, velocity: 81 }, // 80.6 → 81
      { pitch: 48, start: 1, length: 0.25, velocity: 64 },
    ]);
  });

  it("does not log a MIDI clip as unmappable once notes are extracted", () => {
    const ir = parseAls(Buffer.from(ALS_MIDI), "midi.als");
    expect(ir.unmappable.some((u) => /not implemented/i.test(u))).toBe(false);
  });
});
