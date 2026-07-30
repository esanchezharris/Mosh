import { AGENT_COMMANDS, type AgentCommand, type ArgSpec } from "./commands";

export type CapabilityCategory =
  | "automation"
  | "capture"
  | "clips"
  | "export"
  | "generative"
  | "history"
  | "lyrics"
  | "midi"
  | "mixer"
  | "plugins"
  | "recording"
  | "routing"
  | "sections"
  | "status"
  | "tracks"
  | "transport";

export type CapabilitySafety = "direct-safe" | "supervisor";

export type CapabilityArgumentSchema = {
  readonly type: "string" | "number" | "boolean";
  readonly description?: string;
};

export type CapabilityInputSchema = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, CapabilityArgumentSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
};

export type Capability = {
  readonly id: string;
  readonly category: CapabilityCategory;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly inputSchema: CapabilityInputSchema;
  readonly safety: CapabilitySafety;
};

/** Commands that can be sent directly only through the validated MoshOps executor.
 * `set_transport` covers play/stop/locate, and `set_clip_loop` covers loop toggles. */
export const DIRECT_SAFE_COMMAND_IDS = [
  "set_clip_loop",
  "set_transport",
  "set_metronome",
  "undo",
  "redo",
  "detect_clip_bpm",
  "list_takes",
  "list_track_outputs",
  "list_builtins",
  "list_plugins",
  "get_rhymes",
  "analyze_lyrics",
] as const;

const DIRECT_SAFE_IDS = new Set<string>(DIRECT_SAFE_COMMAND_IDS);
const DEFAULT_CAPABILITY_LIMIT = 16;
const TOKEN = /[a-z0-9]+/g;
const STOP_WORDS = new Set(["a", "add", "an", "and", "at", "by", "change", "create", "for", "from", "in", "it", "make", "my", "of", "on", "or", "remove", "set", "the", "this", "to", "turn", "with"]);

function categoryFor(command: string): CapabilityCategory {
  if (/^(create|rename|move|remove)_section$/.test(command) || command.includes("annotation")) return "sections";
  if (/^(create|rename|remove)_track$/.test(command)) return "tracks";
  if (command.includes("clip") || command === "delete_time_range") return "clips";
  if (command === "sketch_beatbox") return "capture";
  if (command.includes("note") || command.includes("drum")) return "midi";
  if (command.includes("tempo") || command === "set_time_signature" || command === "set_metronome" || command === "set_key" || command === "set_count_in" || command === "set_transport") return "transport";
  if (command.includes("take") || command.includes("record") || command === "arm_track" || command === "set_input_monitor") return "recording";
  if (command === "undo" || command === "redo" || command === "save") return "history";
  if (command.includes("volume") || command.includes("pan") || command.includes("mute") || command.includes("solo")) return "mixer";
  if (command.includes("bus") || command.includes("send") || command.includes("output")) return "routing";
  if (command.includes("plugin") || command.includes("builtin") || command.includes("sample")) return "plugins";
  if (command.startsWith("export_")) return "export";
  if (command.includes("automation")) return "automation";
  if (command.includes("render") || command === "bypass_layer" || command === "freeze_layer" || command === "unfreeze_layer") return "generative";
  if (command.includes("lyric") || command === "get_rhymes" || command === "build_skeleton_from_clip") return "lyrics";
  return "status";
}

function tokens(value: string): readonly string[] {
  const matches = value.toLowerCase().match(TOKEN) ?? [];
  return [...new Set(matches.filter((word) => word.length > 1 && !STOP_WORDS.has(word)))];
}

function inputSchemaFor(args: readonly ArgSpec[]): CapabilityInputSchema {
  const properties: Record<string, CapabilityArgumentSchema> = {};
  const required: string[] = [];
  for (const argument of args) {
    properties[argument.name] = argument.desc === undefined
      ? { type: argument.type }
      : { type: argument.type, description: argument.desc };
    if (argument.required) required.push(argument.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function capabilityFor(command: AgentCommand): Capability {
  const category = categoryFor(command.command);
  const commandTerms = [
    command.command.replace(/_/g, " "),
    command.desc,
    ...command.args.flatMap((argument) => [argument.name, argument.desc ?? ""]),
    category,
  ].join(" ");
  return {
    id: command.command,
    category,
    description: command.desc,
    triggers: tokens(commandTerms),
    inputSchema: inputSchemaFor(command.args),
    safety: DIRECT_SAFE_IDS.has(command.command) ? "direct-safe" : "supervisor",
  };
}

/** Stable, catalog-derived index. A new AGENT_COMMANDS entry appears here automatically. */
export const CAPABILITY_INDEX: readonly Capability[] = AGENT_COMMANDS.map(capabilityFor);

export type CapabilityRetrievalOptions = { readonly limit?: number };

function scoreCapability(queryTokens: ReadonlySet<string>, capability: Capability): number {
  let score = queryTokens.has(capability.category) ? 2 : 0;
  for (const trigger of capability.triggers) if (queryTokens.has(trigger)) score += 1;
  return score;
}

/** Deterministic lexical retrieval. Direct-safe commands are the stable baseline;
 * all editing, generative, and ambiguous commands require an explicit match. */
export function retrieveCapabilities(query: string, options: CapabilityRetrievalOptions = {}): readonly Capability[] {
  const limit = Math.max(DIRECT_SAFE_COMMAND_IDS.length, Math.floor(options.limit ?? DEFAULT_CAPABILITY_LIMIT));
  const queryTokens = new Set(tokens(query));
  const direct = CAPABILITY_INDEX.filter((capability) => capability.safety === "direct-safe");
  const matched = CAPABILITY_INDEX
    .filter((capability) => capability.safety === "supervisor")
    .map((capability) => ({ capability, score: scoreCapability(queryTokens, capability) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.capability.id.localeCompare(right.capability.id));
  return [...direct, ...matched.map((candidate) => candidate.capability)].slice(0, limit);
}

function renderArguments(capability: Capability): string {
  return Object.entries(capability.inputSchema.properties)
    .map(([name, schema]) => `${name}${capability.inputSchema.required.includes(name) ? "" : "?"}:${schema.type}`)
    .join(", ");
}

/** Compact prompt renderer for production supervisor turns. */
export function capabilityCatalogPrompt(capabilities: readonly Capability[]): string {
  return capabilities
    .map((capability) => `- ${capability.id}(${renderArguments(capability)}) [${capability.category}; ${capability.safety}] — ${capability.description}`)
    .join("\n");
}

/** Structural shape accepted by Task 1's SupervisorTurn capabilitySchemas field. */
export type SupervisorCapabilitySchema = {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: CapabilityInputSchema;
};

export function supervisorCapabilitySchemas(capabilities: readonly Capability[]): readonly SupervisorCapabilitySchema[] {
  return capabilities.map(({ id, description, inputSchema }) => ({ id, description, inputSchema }));
}
