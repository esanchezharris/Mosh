# MoshIR v0.1 cheatsheet (the CLOSED vocabulary — nothing else exists)

Time: positions in 1-based bars (`start_bar`), durations in beats
(`length_beats`, `dur_beats`, `start_beats` clip-relative). Set tempo first.
Ids: you assign them (`t1`, `c1`, `d1`, `a1`, `bverb`); create before use.

## project
- project.set_tempo {bpm: 20..400}
- project.set_time_sig {num: 1..32, denom: 1|2|4|8|16|32}
- project.set_key {root: C..B (sharps/flats ok), scale: major|minor|harmonic_minor|melodic_minor|dorian|phrygian|lydian|mixolydian|locrian}
- project.set_swing {amount: 0..1}   — currently UNSUPPORTED (gap-ledgered); avoid

## track
- track.create {track_id, kind: audio|midi|bus, role?: drums|808|melody|vox|fx|bus, name?}
- track.rename {track_id, name} · track.set_role {track_id, role} · track.delete {track_id}
- track.route {track_id, to: <bus track id>}

## asset / latent (stochastic → seed REQUIRED; latent also model_version)
- asset.resolve {descriptor: {text, tags?: [..]}, strategy: ["local","splice","latent_gen"]} + "out": "a1"
- latent.generate {prompt, duration_beats, seed, model_version} + "out": "a2"
- latent.variate {asset_id, strength: 0..1, seed, model_version} + "out": "a3"
- latent.morph / latent.inpaint — UNSUPPORTED in this build; avoid

## clip
- clip.create {clip_id, track_id, start_bar, length_beats, kind: midi}   (audio clips come from sample.place)
- clip.move {clip_id, start_bar, track_id?} · clip.delete {clip_id} · clip.set_length {clip_id, length_beats}
- clip.duplicate {clip_id, new_clip_id, start_bar?} — copy a clip (defaults to landing right after the source); the cheap way to extend a pattern

## notes (MIDI; pitch "C1".."B8" or 0..127; vel 1..127)
- notes.add {clip_id, notes: [{pitch, start_beats, dur_beats, vel}]}
- notes.remove {clip_id, pitches?, range?: {start_beats, length_beats}}
- notes.transpose {clip_id, semitones: -48..48}
- notes.quantize {clip_id, grid: "1/4"|"1/8"|"1/16"|"1/32"|"1/8T"|"1/16T", strength: 0..1}
- notes.humanize {clip_id, timing_ms: 0..100, vel_var: 0..64, seed}

## sample (on audio clips placed from assets)
- sample.place {clip_id, track_id, asset_id, start_bar, offset_beats?}
- sample.pitch {clip_id, semitones: -24..24} · sample.stretch {clip_id, ratio: 0.25..4, algo?}
- sample.slice {clip_id, mode: "grid", grid} (mode "transient" UNSUPPORTED)

## device (per-track chain; prefer list resolves first available)
- device.add {device_id, track_id, role: synth|sampler|eq|comp|saturator|delay|reverb|limiter|filter|util, prefer?: ["Serum","builtin.synth"]}
  builtins: builtin.synth (4-osc) · builtin.sampler · builtin.eq · builtin.comp ·
  builtin.sat (the neural saturator) · builtin.delay · builtin.reverb · builtin.filter
- device.load_sound {device_id, asset_id, key_note?: pitch, min_note?, max_note?, open_ended?: bool}
  — load a resolved asset INTO a sampler (v0.2: a sampler with no sound is
  SILENT; resolve → add sampler → load_sound is the audible chain). key_note
  maps the sample's root to the pitch your notes use.
  DRUM RACK recipe: ONE track + ONE builtin.sampler; one load_sound per drum
  channel with min_note=max_note=key_note (e.g. kick D1, clap E1, hat F#1) so
  pads never overlap; all lanes in ONE pattern clip. 808/melodic = own tracks.
- device.set_param {device_id, param: "drive"|"cutoff"|... | <raw index>, value_norm: 0..1}
- device.bypass {device_id, bypassed} · device.load_preset — UNSUPPORTED; avoid

## mixer
- mixer.set_gain {track_id, db: -96..12} · mixer.set_pan {track_id, pan: -1..1}
- mixer.send {track_id, to_bus: <bus track id>, db}   (create the bus with track.create kind=bus first)
- mixer.sidechain {src: <trigger track>, dst: <ducked track>, amount: 0..1, attack_ms?, release_ms?, ratio?}

## automation / arrange / render
- automation.write {target: {device_id, param} | {mixer: "gain"|"pan", track_id}, points: [{pos_beats, value_norm, curve?: -1..1}]}
- arrange.create_section {name, start_bar, length_bars} · arrange.place {clip_id, section | start_bar}
- render.commit {} (checkpoint) · render.bounce {range_bars?, tracks?} + "out": "render1"
