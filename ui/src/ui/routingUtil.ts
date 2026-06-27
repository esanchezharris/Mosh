// G8 — pure helpers for the Mixer "out:" routing picker. Translates between the
// snapshot's track.output shape, the list_track_outputs enumeration, and the
// set_track_output command args — keeping the Mixer component a thin shell and
// the logic fully unit-tested (the project has no React render-test surface).
//
// A track routes to one of: Default | another track (destTrackId) | a hardware
// output (deviceID). Self is never an option. Backend contract: SelfTest.cpp
// "Wave S" (routing). All routing changes still go through one mutation path —
// store.exec("set_track_output", routingArgs(...)).

import type { TrackOutputs, Track } from "../types";

export type RoutingOption = { value: string; label: string };

/** Build the ordered option list for a track's out selector:
 *  Default, then candidate tracks (self excluded), then hardware outputs.
 *  Empty when routing hasn't been loaded yet (trackOutputs null). */
export function routingOptions(trackId: string, to: TrackOutputs | null): RoutingOption[] {
  if (!to) return [];
  const opts: RoutingOption[] = [{ value: "default", label: "Default" }];
  for (const t of to.tracks) {
    if (t.id === trackId) continue; // a track can't route into itself
    opts.push({ value: `track:${t.id}`, label: t.name });
  }
  for (const o of to.outputs) {
    opts.push({ value: `out:${o.deviceID}`, label: o.name });
  }
  return opts;
}

/** Map a selected option value to the set_track_output args the backend reads. */
export function routingArgs(trackId: string, value: string): Record<string, unknown> {
  if (value.startsWith("track:")) return { trackId, destTrackId: value.slice("track:".length) };
  if (value.startsWith("out:")) return { trackId, deviceID: value.slice("out:".length) };
  return { trackId, output: "default" };
}

/** Derive the currently-selected option value from a track's snapshot output. */
export function currentRoutingValue(track: Track): string {
  const out = track.output;
  if (!out) return "default";
  if (out.isTrack && out.destId) return `track:${out.destId}`;
  if (!out.isTrack && out.deviceID) return `out:${out.deviceID}`;
  return "default";
}
