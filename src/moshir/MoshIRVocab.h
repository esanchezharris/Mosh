#pragma once

// The closed MoshIR v0.2 op vocabulary (phase0 spec §3.3 + the one budgeted
// post-friction revision: device.load_sound, the asset→sampler binding that
// the replication ladder proved blocking). Schema order. Engine-free on
// purpose: included by the executor AND the Catch2 lockstep test, which diffs
// this list against moshir/moshir-0.2.schema.json so the C++ and Python sides
// can never drift apart silently.

namespace mosh::ir
{
inline constexpr const char* kIrVersion = "0.2";

inline constexpr const char* kOpKinds[] = {
    "project.set_tempo", "project.set_swing", "project.set_key", "project.set_time_sig",
    "track.create", "track.rename", "track.set_role", "track.route", "track.delete",
    "asset.resolve",
    "latent.generate", "latent.variate", "latent.morph", "latent.inpaint",
    "clip.create", "clip.move", "clip.duplicate", "clip.delete", "clip.set_length",
    "notes.add", "notes.remove", "notes.transpose", "notes.quantize", "notes.humanize",
    "sample.place", "sample.slice", "sample.pitch", "sample.stretch",
    "device.add", "device.load_sound", "device.set_param", "device.load_preset", "device.bypass",
    "mixer.set_gain", "mixer.set_pan", "mixer.send", "mixer.sidechain",
    "automation.write",
    "arrange.create_section", "arrange.place",
    "render.commit", "render.bounce",
};

inline constexpr int kNumOpKinds = (int) (sizeof (kOpKinds) / sizeof (kOpKinds[0]));

} // namespace mosh::ir
