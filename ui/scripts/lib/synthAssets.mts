// Tiny real WAV assets for file-taking synthesis targets (import_clip,
// assign_sample, sketch_beatbox). The file-existence grader requires the path in
// the request to actually exist; task-gen hints point at these. 16-bit PCM mono.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function wavBuffer(samples: Float32Array, rate = 44100): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);        // block align
  header.writeUInt16LE(16, 34);       // bits
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function tone(seconds: number, freq: number, rate = 44100): Float32Array {
  const s = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < s.length; i++) {
    const env = Math.min(1, (s.length - i) / (rate * 0.05)) * Math.min(1, i / (rate * 0.005));
    s[i] = 0.6 * env * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return s;
}

// A click pattern that looks like a beatbox take at 90 BPM (2 bars).
function clicks(rate = 44100): Float32Array {
  const beat = (60 / 90) * rate;
  const s = new Float32Array(Math.round(beat * 8));
  for (let b = 0; b < 8; b++) {
    const at = Math.round(b * beat);
    const f = b % 2 === 0 ? 80 : 220; // kick-ish / snare-ish alternation
    for (let i = 0; i < rate * 0.08 && at + i < s.length; i++) {
      s[at + i] += 0.8 * Math.exp(-i / (rate * 0.02)) * Math.sin((2 * Math.PI * f * i) / rate);
    }
  }
  return s;
}

export type SynthAssets = { loop: string; kick: string; beatbox: string };

export function ensureSynthAssets(dir: string): SynthAssets {
  mkdirSync(dir, { recursive: true });
  const assets = {
    loop: join(dir, "loop.wav"),
    kick: join(dir, "kick.wav"),
    beatbox: join(dir, "beatbox-90bpm.wav"),
  };
  if (!existsSync(assets.loop)) writeFileSync(assets.loop, wavBuffer(tone(1.0, 440)));
  if (!existsSync(assets.kick)) writeFileSync(assets.kick, wavBuffer(tone(0.2, 60)));
  if (!existsSync(assets.beatbox)) writeFileSync(assets.beatbox, wavBuffer(clicks()));
  return assets;
}
