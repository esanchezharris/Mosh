import { create } from "zustand";
import { z } from "zod";
import { DEFAULT_TRACK_GROUP_MIX_ATTRIBUTES } from "../../types";
import type { Snapshot, Track } from "../../types";
import type { AgentCommandCall } from "../destructiveScreen";

export type ProducerRack = { readonly projectId: string; readonly leadTrackId: string; readonly roomTrackId: string; readonly pluginIndex: number };
export type ProducerScope = "initial" | "room";
export const useProducerRack = create<{ rack: ProducerRack | null; setRack(rack: ProducerRack | null): void }>((set) => ({ rack: null, setRack: (rack) => set({ rack }) }));
const allowedCall = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("set_track_volume"), args: z.strictObject({ trackId: z.string(), db: z.number().finite() }) }),
  z.strictObject({ command: z.literal("set_plugin_param"), args: z.strictObject({ trackId: z.string(), index: z.number().int(), paramIndex: z.number().int(), value: z.number().finite() }) }),
  z.strictObject({ command: z.literal("bypass_plugin"), args: z.strictObject({ trackId: z.string(), index: z.number().int(), bypassed: z.boolean() }) }),
]);
const qualifiedFrequency = (value: number): boolean => [80, 120].some((hz) => Math.abs(value - (hz - 10) / 21990) <= 1e-9);

function trackProblem(snapshot: Snapshot, track: Track): string | null {
  if (track.type !== "audio" || track.isGroup || track.isReturn || track.active === false || track.frozen)
    return `${track.name} must be an active, unfrozen audio track`;
  if ((track.automationMode ?? "read") !== "read") return `${track.name} must use read automation mode`;
  const fader = track.mixerPlugins?.find((plugin) => plugin.type === "volume" && !plugin.external)?.params.find((param) => param.index === 0 && param.name === "Volume");
  if (!fader) return `${track.name} has no verified existing fader`;
  if (fader.automated !== false || fader.points?.length) return `${track.name} fader automation is outside this rack`;
  if (!snapshot.trackGroupsSuspended && snapshot.trackGroups?.some((group) => group.enabled && group.kind !== "edit"
    && group.trackIds.includes(track.id) && group.trackIds.some((id) => id !== track.id && snapshot.tracks.some((other) => other.id === id))
    && (group.mixAttributes ?? DEFAULT_TRACK_GROUP_MIX_ATTRIBUTES).includes("main_volume")))
    return `${track.name} has linked fader group effects`;
  return null;
}

export function validateProducerRack(snapshot: Snapshot, rack: ProducerRack, calls: readonly AgentCommandCall[], scope: ProducerScope): string | null {
  if (!rack.projectId || rack.leadTrackId === rack.roomTrackId) return "Choose a distinct lead and printed-room track for this project";
  if (calls.length > 6) return "The rack permits at most six commands";
  const lead = snapshot.tracks.find((track) => track.id === rack.leadTrackId);
  const room = snapshot.tracks.find((track) => track.id === rack.roomTrackId);
  if (!lead || !room) return "A selected rack track no longer exists";
  for (const track of [lead, room]) {
    const problem = trackProblem(snapshot, track);
    if (problem) return problem;
  }
  const plugin = lead.plugins?.find((candidate) => candidate.index === rack.pluginIndex);
  if (!plugin || plugin.type !== "highpass" || plugin.external || plugin.builtin !== true)
    return "The selected lead insert is no longer the native high-pass";
  const frequency = plugin.params.find((param) => param.index === 0 && param.name === "Frequency");
  if (!frequency || frequency.min !== 10 || frequency.max !== 22000 || !frequency.display?.endsWith(" Hz"))
    return "The high-pass frequency identity, physical limits, or readback is unavailable";
  if (frequency.automated !== false || frequency.points?.length) return "High-pass automation is outside this rack";
  let nextFrequency = frequency.value;
  for (const call of calls) {
    const parsed = allowedCall.safeParse(call);
    if (!parsed.success) return "The proposal contains an unsupported command or argument";
    const command = parsed.data;
    switch (command.command) {
      case "set_track_volume": {
        const { trackId, db } = command.args;
        const levels = trackId === rack.roomTrackId ? [0, -6] : trackId === rack.leadTrackId && scope === "initial" ? [-6, 0, 3] : [];
        if (!levels.includes(db)) return "The proposal changes a protected track or an unqualified fader setting";
        break;
      }
      case "set_plugin_param":
        if (scope !== "initial" || command.args.trackId !== rack.leadTrackId || command.args.index !== rack.pluginIndex
          || command.args.paramIndex !== 0 || !qualifiedFrequency(command.args.value))
          return "Only the selected lead high-pass frequency at 80 or 120 Hz is allowed";
        nextFrequency = command.args.value;
        break;
      case "bypass_plugin":
        if (scope !== "initial" || command.args.trackId !== rack.leadTrackId || command.args.index !== rack.pluginIndex)
          return "Only the selected lead high-pass bypass is allowed";
        if (!command.args.bypassed && !qualifiedFrequency(nextFrequency)) return "Set the high-pass to 80 or 120 Hz before enabling it";
        break;
    }
  }
  return null;
}

export function producerRackPrompt(rack: ProducerRack, scope: ProducerScope): string {
  const room = `Printed-room track ${JSON.stringify(rack.roomTrackId)}: set_track_volume with db exactly 0 or -6.`;
  const controls = scope === "room" ? room : `${room}
Lead track ${JSON.stringify(rack.leadTrackId)}: set_track_volume with db exactly -6, 0, or 3.
Native high-pass on that lead at index ${rack.pluginIndex}: bypass_plugin with bypassed boolean, or set_plugin_param with paramIndex 0 and value ${70 / 21990} (80 Hz) or ${110 / 21990} (120 Hz). Set a qualified frequency before enabling.`;
  return `Producer v0 bounded rack for project ${JSON.stringify(rack.projectId)}. ${controls}
${scope === "room" ? "This revision may change only the printed-room fader. Preserve the chosen lead tone and level." : "Use only these existing controls and exact target IDs."}
All other tracks, clips, arrangement, recordings, routing, sends, automation, and processing are protected. Compression is excluded. Propose at most six concrete commands. No other command or argument is permitted. These controls have bounded implementation qualification, not a musical-quality guarantee.`;
}
