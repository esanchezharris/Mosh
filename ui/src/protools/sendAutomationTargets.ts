import type { Plugin, PluginParam, Snapshot, Track } from "../types";
import {
  automationTargetByName,
  type AutomationTarget,
} from "./automationEditing";

type SendAutomationKind = "level" | "pan" | "mute";

export type ProToolsAutomationTargetId =
  | "volume"
  | `send:${number}:${SendAutomationKind}`;

export type ProToolsAutomationTargetOption = {
  readonly id: ProToolsAutomationTargetId;
  readonly label: string;
  readonly target: AutomationTarget;
};

const SEND_KINDS: readonly SendAutomationKind[] = ["level", "pan", "mute"];

function targetFrom(plugin: Plugin, param: PluginParam): AutomationTarget {
  return {
    pluginIndex: plugin.index,
    paramIndex: param.index,
    paramName: param.name,
    value: param.value,
    points: param.points ?? [],
    discrete: param.discrete,
    states: param.states,
  };
}

function parseSendTargetId(targetId: ProToolsAutomationTargetId): {
  readonly bus: number;
  readonly kind: SendAutomationKind;
} | null {
  const match = /^send:(\d+):(level|pan|mute)$/.exec(targetId);
  if (!match) return null;
  const bus = Number(match[1]);
  return Number.isSafeInteger(bus) ? { bus, kind: match[2] as SendAutomationKind } : null;
}

function exactSendTarget(track: Track, targetId: ProToolsAutomationTargetId): AutomationTarget | null {
  const parsed = parseSendTargetId(targetId);
  if (!parsed) return null;
  const send = track.sends?.find((candidate) => candidate.bus === parsed.bus);
  const address = send?.automation;
  if (!address) return null;
  const plugin = [...(track.plugins ?? []), ...(track.mixerPlugins ?? [])]
    .find((candidate) => candidate.index === address.pluginIndex);
  if (!plugin) return null;
  const paramIndex = parsed.kind === "level" ? address.levelParamIndex
    : parsed.kind === "pan" ? address.panParamIndex
      : address.muteParamIndex;
  const param = plugin.params.find((candidate) => candidate.index === paramIndex);
  return param ? targetFrom(plugin, param) : null;
}

export function resolveProToolsAutomationTarget(
  track: Track,
  targetId: ProToolsAutomationTargetId,
): AutomationTarget | null {
  if (targetId === "volume") return automationTargetByName(track, "Volume");
  return exactSendTarget(track, targetId) ?? automationTargetByName(track, "Volume");
}

export function proToolsAutomationTargets(
  track: Track,
  snapshot: Snapshot,
): readonly ProToolsAutomationTargetOption[] {
  const options: ProToolsAutomationTargetOption[] = [];
  const volume = resolveProToolsAutomationTarget(track, "volume");
  if (volume) options.push({ id: "volume", label: "Volume", target: volume });

  for (const send of track.sends ?? []) {
    const busName = snapshot.buses?.find((candidate) => candidate.bus === send.bus)?.name
      ?? `Bus ${send.bus + 1}`;
    for (const kind of SEND_KINDS) {
      const id = `send:${send.bus}:${kind}` as const;
      const target = exactSendTarget(track, id);
      if (!target) continue;
      const label = `${busName} · ${kind[0].toUpperCase()}${kind.slice(1)}`;
      options.push({ id, label, target: { ...target, paramName: label } });
    }
  }
  return options;
}
