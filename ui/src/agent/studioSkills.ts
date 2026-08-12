import type { ChangeSet, AgentCommandCall } from "./executor";
import type { AvailablePlugin, CommandResult } from "../types";
import {
  addPluginRecent,
  installedEntry,
  resolvePluginMatch,
  type PluginEntry,
} from "../ui/pluginBrowserUtil";

export type StudioContext = {
  readonly projectEpoch: number;
  readonly selectedTrackId: string | null;
  readonly tracks: readonly { readonly id: string; readonly name: string }[];
};

export type Observation<T> =
  | { readonly kind: "observed"; readonly projectEpoch: number; readonly value: T }
  | { readonly kind: "failed"; readonly reason: string };

export type SkillOutcome =
  | { readonly kind: "completed"; readonly skill: string; readonly say: string; readonly changes: ChangeSet }
  | {
    readonly kind: "needs_choice";
    readonly skill: string;
    readonly say: string;
    readonly options: readonly string[];
    readonly continuation?: StudioSkillContinuation;
  }
  | { readonly kind: "blocked"; readonly skill: string; readonly say: string }
  | { readonly kind: "unsupported"; readonly say: string };

type PluginChoice = { readonly label: string; readonly entry: PluginEntry };

export type StudioSkillContinuation = {
  readonly kind: "load_named_plugin";
  readonly projectEpoch: number;
  readonly trackId: string;
  readonly trackName: string;
  readonly choices: readonly PluginChoice[];
};

export type StudioSkillEnvironment = {
  readonly context: () => StudioContext;
  readonly exec: (command: string, args: Record<string, unknown>) => Promise<CommandResult>;
  readonly runBatch: (label: string, calls: readonly AgentCommandCall[]) => Promise<ChangeSet>;
};

export type StudioSkill = {
  readonly id: string;
  readonly description: string;
  readonly run: (utterance: string, environment: StudioSkillEnvironment) => Promise<SkillOutcome | null>;
};

const MAX_PLUGIN_CATALOG = 4_096;
const MAX_PLUGIN_FIELD_LENGTH = 1_024;
const LOAD_PLUGIN_UTTERANCE = /^(?:(?:can|could|would|will)\s+you\s+|please\s+|hey\s+moshi[, ]+)*(?:load|add|insert|put)\s+(?:(?:the|a)\s+)?(?:plugin\s+)?(.+?)(?:\s+(?:on|onto)\s+(?:the\s+)?(?:selected|current|this)\s+track)?[?!.]*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePlugin(value: unknown): AvailablePlugin | null {
  if (!isRecord(value)) return null;
  const { id, name, format, manufacturer, isInstrument } = value;
  if (typeof id !== "string" || typeof name !== "string" || typeof format !== "string"
    || typeof manufacturer !== "string" || typeof isInstrument !== "boolean") return null;
  if (!id || !name || id.length > MAX_PLUGIN_FIELD_LENGTH || name.length > MAX_PLUGIN_FIELD_LENGTH
    || format.length > MAX_PLUGIN_FIELD_LENGTH || manufacturer.length > MAX_PLUGIN_FIELD_LENGTH) return null;
  return { id, name, format, manufacturer, isInstrument };
}

function parsePluginCatalog(data: unknown): readonly PluginEntry[] | null {
  if (!isRecord(data) || !Array.isArray(data.plugins) || data.plugins.length > MAX_PLUGIN_CATALOG) return null;
  const entries: PluginEntry[] = [];
  for (const raw of data.plugins) {
    const plugin = parsePlugin(raw);
    if (!plugin) return null;
    entries.push(installedEntry(plugin));
  }
  return entries;
}

function pluginQuery(utterance: string): string | null {
  const match = utterance.trim().match(LOAD_PLUGIN_UTTERANCE);
  const query = match?.[1]?.trim();
  return query ? query : null;
}

async function observePlugins(environment: StudioSkillEnvironment): Promise<Observation<readonly PluginEntry[]>> {
  const projectEpoch = environment.context().projectEpoch;
  const result = await environment.exec("list_plugins", {});
  if (!result.ok) return { kind: "failed", reason: result.error ?? "the plug-in catalog could not be read" };
  const plugins = parsePluginCatalog(result.data);
  if (!plugins) return { kind: "failed", reason: "the plug-in catalog returned invalid data" };
  return { kind: "observed", projectEpoch, value: plugins };
}

function pluginChoices(entries: readonly PluginEntry[]): readonly PluginChoice[] {
  const baseLabels = entries.map((entry) => `${entry.name} — ${entry.meta}`);
  const totals = new Map<string, number>();
  for (const label of baseLabels) totals.set(label, (totals.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return entries.map((entry, index) => {
    const base = baseLabels[index] ?? entry.name;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return {
      entry,
      label: (totals.get(base) ?? 0) > 1 ? `${base} (${occurrence})` : base,
    };
  });
}

function numberedChoices(choices: readonly PluginChoice[]): string {
  return choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("; ");
}

function choiceFromReply(reply: string, choices: readonly PluginChoice[]): PluginEntry | null {
  const normalized = reply.trim().toLowerCase();
  const numbered = normalized.match(/^(?:option\s+)?([1-5])$/)?.[1];
  if (numbered) return choices[Number(numbered) - 1]?.entry ?? null;
  const exactLabel = choices.find((choice) => choice.label.toLowerCase() === normalized);
  if (exactLabel) return exactLabel.entry;
  const match = resolvePluginMatch(choices.map((choice) => choice.entry), reply);
  return match.kind === "unique" ? match.entry : null;
}

async function loadChosenPlugin(
  entry: PluginEntry,
  target: Pick<StudioSkillContinuation, "projectEpoch" | "trackId" | "trackName">,
  environment: StudioSkillEnvironment,
): Promise<SkillOutcome> {
  const current = environment.context();
  if (current.projectEpoch !== target.projectEpoch || current.selectedTrackId !== target.trackId) {
    return { kind: "blocked", skill: "load_named_plugin", say: "the project or selected track changed — try again" };
  }
  const changes = await environment.runBatch(`load ${entry.name}`, [{
    command: "load_plugin",
    args: { trackId: target.trackId, pluginId: entry.loadKey },
  }]);
  const load = changes.entries.find((change) => change.command === "load_plugin");
  if (!load?.ok) {
    const error = load?.error ?? "the plug-in host refused it";
    const guidance = /instrument.*audio|audio.*instrument/i.test(error)
      ? "select or create an instrument track and try again"
      : error;
    return { kind: "blocked", skill: "load_named_plugin", say: `I couldn't load ${entry.name} — ${guidance}` };
  }

  addPluginRecent(entry.uid);
  const after = environment.context();
  const moved = after.projectEpoch !== target.projectEpoch || after.selectedTrackId !== target.trackId;
  return {
    kind: "completed",
    skill: "load_named_plugin",
    say: moved
      ? `loaded ${entry.name} on ${target.trackName} before the project or selection changed`
      : `loaded ${entry.name} on ${target.trackName}`,
    changes,
  };
}

async function continuePluginChoice(
  utterance: string,
  continuation: StudioSkillContinuation,
  environment: StudioSkillEnvironment,
): Promise<SkillOutcome> {
  const current = environment.context();
  if (current.projectEpoch !== continuation.projectEpoch || current.selectedTrackId !== continuation.trackId) {
    return { kind: "blocked", skill: "load_named_plugin", say: "the project or selected track changed — try again" };
  }
  const entry = choiceFromReply(utterance, continuation.choices);
  if (!entry) {
    return {
      kind: "needs_choice",
      skill: "load_named_plugin",
      say: `choose 1–${continuation.choices.length}: ${numberedChoices(continuation.choices)}`,
      options: continuation.choices.map((choice) => choice.label),
      continuation,
    };
  }
  return loadChosenPlugin(entry, continuation, environment);
}

const LOAD_NAMED_PLUGIN_SKILL: StudioSkill = {
  id: "load_named_plugin",
  description: "Find an installed plug-in by producer-facing name and load it on the selected track.",
  run: async (utterance, environment) => {
    const query = pluginQuery(utterance);
    if (!query) return null;

    const initial = environment.context();
    if (!initial.selectedTrackId) {
      return {
        kind: "needs_choice",
        skill: "load_named_plugin",
        say: "select the track you want me to load it on",
        options: [],
      };
    }
    const track = initial.tracks.find((candidate) => candidate.id === initial.selectedTrackId);
    if (!track) {
      return {
        kind: "blocked",
        skill: "load_named_plugin",
        say: "that selected track is no longer available",
      };
    }

    const observation = await observePlugins(environment);
    if (observation.kind === "failed") {
      return { kind: "blocked", skill: "load_named_plugin", say: `I couldn't load ${query} because ${observation.reason}` };
    }
    if (environment.context().projectEpoch !== observation.projectEpoch) {
      return { kind: "blocked", skill: "load_named_plugin", say: "the project changed while I was finding that plug-in — try again" };
    }

    const match = resolvePluginMatch(observation.value, query);
    if (match.kind === "none") {
      return {
        kind: "blocked",
        skill: "load_named_plugin",
        say: `I couldn't find ${query} — open Plug-in Manager or rescan, then try again`,
      };
    }
    if (match.kind === "ambiguous") {
      const choices = pluginChoices(match.entries);
      const continuation: StudioSkillContinuation = {
        kind: "load_named_plugin",
        projectEpoch: observation.projectEpoch,
        trackId: track.id,
        trackName: track.name,
        choices,
      };
      return {
        kind: "needs_choice",
        skill: "load_named_plugin",
        say: `choose 1–${choices.length}: ${numberedChoices(choices)}`,
        options: choices.map((choice) => choice.label),
        continuation,
      };
    }
    return loadChosenPlugin(match.entry, {
      projectEpoch: observation.projectEpoch,
      trackId: track.id,
      trackName: track.name,
    }, environment);
  },
};

export const STUDIO_SKILL_MANIFEST = [{
  id: LOAD_NAMED_PLUGIN_SKILL.id,
  description: LOAD_NAMED_PLUGIN_SKILL.description,
}] as const;

const STUDIO_SKILLS: readonly StudioSkill[] = [LOAD_NAMED_PLUGIN_SKILL];

export async function runStudioSkill(
  utterance: string,
  environment: StudioSkillEnvironment,
  continuation?: StudioSkillContinuation,
): Promise<SkillOutcome> {
  if (continuation) return continuePluginChoice(utterance, continuation, environment);
  for (const skill of STUDIO_SKILLS) {
    const outcome = await skill.run(utterance, environment);
    if (outcome) return outcome;
  }
  return { kind: "unsupported", say: "I can't do that reliably yet" };
}
