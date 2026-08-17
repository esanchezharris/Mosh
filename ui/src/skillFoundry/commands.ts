// Slice D — `teach-moshi` argument parsing and command dispatch.
//
// Task 1: `parseTeachMoshiArgsV1` (pure, table-driven flag parser) and `runTeachMoshiV1`
// (dispatches a parsed command through injected `TeachMoshiDepsV1`, producing a
// `CliExecutionV1`). `createStubTeachMoshiDepsV1` gives `cli.ts` something typecheckable to
// run before real services exist; Task 10 replaces it with real service wiring so every
// command in the acceptance matrix has a durable effect.

import type {
  CliArgsParseResultV1,
  CliExecutionV1,
  CommandHandlerResultV1,
  TeachMoshiCommandNameV1,
  TeachMoshiCommandV1,
  TeachMoshiDepsV1,
} from "./contracts";

type FlagKindV1 = "string" | "boolean";

type FlagSpecV1 = { flag: string; kind: FlagKindV1; required: boolean; field: string };

const COMMAND_FLAGS_V1: Readonly<Record<TeachMoshiCommandNameV1, readonly FlagSpecV1[]>> = Object.freeze({
  init: [
    { flag: "--goal", kind: "string", required: true, field: "goal" },
    { flag: "--id", kind: "string", required: false, field: "id" },
  ],
  "add-source": [
    { flag: "--draft", kind: "string", required: true, field: "draftId" },
    { flag: "--card", kind: "string", required: true, field: "cardPath" },
  ],
  "add-reference": [
    { flag: "--draft", kind: "string", required: true, field: "draftId" },
    { flag: "--file", kind: "string", required: true, field: "filePath" },
  ],
  validate: [{ flag: "--draft", kind: "string", required: true, field: "draftId" }],
  certify: [
    { flag: "--draft", kind: "string", required: true, field: "draftId" },
    { flag: "--bin", kind: "string", required: true, field: "bin" },
  ],
  "record-evidence": [
    { flag: "--draft", kind: "string", required: true, field: "draftId" },
    { flag: "--case", kind: "string", required: true, field: "caseId" },
    { flag: "--evidence", kind: "string", required: true, field: "evidencePath" },
  ],
  review: [{ flag: "--draft", kind: "string", required: true, field: "draftId" }],
  approve: [
    { flag: "--draft", kind: "string", required: true, field: "draftId" },
    { flag: "--review-sha", kind: "string", required: true, field: "reviewSha" },
    { flag: "--attestation", kind: "string", required: true, field: "attestationPath" },
  ],
  install: [{ flag: "--draft", kind: "string", required: true, field: "draftId" }],
  rollback: [
    { flag: "--id", kind: "string", required: true, field: "skillId" },
    { flag: "--version", kind: "string", required: true, field: "version" },
  ],
  revoke: [{ flag: "--id", kind: "string", required: true, field: "skillId" }],
  "refresh-source": [{ flag: "--card", kind: "string", required: true, field: "cardPath" }],
  "revoke-source": [{ flag: "--id", kind: "string", required: true, field: "sourceCardId" }],
  gc: [{ flag: "--apply", kind: "boolean", required: false, field: "apply" }],
  status: [{ flag: "--draft", kind: "string", required: true, field: "draftId" }],
});

const KNOWN_COMMANDS_V1: readonly TeachMoshiCommandNameV1[] = Object.keys(COMMAND_FLAGS_V1) as TeachMoshiCommandNameV1[];

function isKnownCommand(value: string): value is TeachMoshiCommandNameV1 {
  return (KNOWN_COMMANDS_V1 as readonly string[]).includes(value);
}

/** Table-driven, pure argv parser. No I/O, no defaults beyond `gc --apply` -> false. */
export function parseTeachMoshiArgsV1(argv: readonly string[]): CliArgsParseResultV1 {
  const commandName = argv[0];
  if (commandName === undefined || commandName.length === 0) {
    return {
      ok: false,
      issues: [{ code: "missing_command", path: "0", message: "a command is required" }],
    };
  }
  if (!isKnownCommand(commandName)) {
    return {
      ok: false,
      issues: [{ code: "unknown_command", path: "0", message: `unknown command "${commandName}"` }],
    };
  }

  const specs = COMMAND_FLAGS_V1[commandName];
  const specByFlag = new Map(specs.map((spec) => [spec.flag, spec] as const));
  const values: Record<string, string | boolean> = {};
  const seen = new Set<string>();
  const rest = argv.slice(1);

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const spec = specByFlag.get(token);
    if (spec === undefined) {
      return {
        ok: false,
        issues: [{ code: "unknown_flag", path: token, message: `unknown flag "${token}" for command "${commandName}"` }],
      };
    }
    if (seen.has(spec.field)) {
      return {
        ok: false,
        issues: [{ code: "duplicate_flag", path: spec.flag, message: `flag "${spec.flag}" was supplied more than once` }],
      };
    }
    seen.add(spec.field);
    if (spec.kind === "boolean") {
      values[spec.field] = true;
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined) {
      return {
        ok: false,
        issues: [{ code: "missing_value", path: spec.flag, message: `flag "${spec.flag}" requires a value` }],
      };
    }
    values[spec.field] = next;
    i += 1;
  }

  for (const spec of specs) {
    if (spec.required && !seen.has(spec.field)) {
      return {
        ok: false,
        issues: [{ code: "missing_required_flag", path: spec.flag, message: `flag "${spec.flag}" is required` }],
      };
    }
  }
  if (specByFlag.has("--apply") && values.apply === undefined) {
    values.apply = false;
  }

  return { ok: true, value: { command: commandName, ...values } as TeachMoshiCommandV1 };
}

const NOT_IMPLEMENTED = async (): Promise<CommandHandlerResultV1> => ({
  ok: false,
  code: "io_error",
  message: "not implemented",
});

/**
 * Stub deps so `cli.ts` typechecks and runs before Task 10 wires real services. Every
 * command fails closed with `io_error` rather than silently succeeding.
 */
export function createStubTeachMoshiDepsV1(): TeachMoshiDepsV1 {
  return {
    init: NOT_IMPLEMENTED,
    "add-source": NOT_IMPLEMENTED,
    "add-reference": NOT_IMPLEMENTED,
    validate: NOT_IMPLEMENTED,
    certify: NOT_IMPLEMENTED,
    "record-evidence": NOT_IMPLEMENTED,
    review: NOT_IMPLEMENTED,
    approve: NOT_IMPLEMENTED,
    install: NOT_IMPLEMENTED,
    rollback: NOT_IMPLEMENTED,
    revoke: NOT_IMPLEMENTED,
    "refresh-source": NOT_IMPLEMENTED,
    "revoke-source": NOT_IMPLEMENTED,
    gc: NOT_IMPLEMENTED,
    status: NOT_IMPLEMENTED,
  };
}

/** Parses, dispatches through `deps`, and always returns — never throws. */
export async function runTeachMoshiV1(argv: readonly string[], deps: TeachMoshiDepsV1): Promise<CliExecutionV1> {
  const parsed = parseTeachMoshiArgsV1(argv);
  if (!parsed.ok) {
    return {
      exitCode: 2,
      envelope: {
        schemaVersion: 1,
        ok: false,
        command: argv[0] ?? "",
        error: {
          code: "usage_error",
          message: parsed.issues[0]?.message ?? "usage error",
          details: { issues: parsed.issues },
        },
      },
    };
  }

  const command = parsed.value;
  const handler = deps[command.command] as (c: TeachMoshiCommandV1) => Promise<CommandHandlerResultV1>;
  try {
    const outcome = await handler(command);
    if (outcome.ok) {
      return {
        exitCode: 0,
        envelope: { schemaVersion: 1, ok: true, command: command.command, result: outcome.result },
      };
    }
    return {
      exitCode: 1,
      envelope: {
        schemaVersion: 1,
        ok: false,
        command: command.command,
        error: { code: outcome.code, message: outcome.message, details: outcome.details ?? {} },
      },
    };
  } catch (err) {
    return {
      exitCode: 1,
      envelope: {
        schemaVersion: 1,
        ok: false,
        command: command.command,
        error: {
          code: "io_error",
          message: err instanceof Error ? err.message : String(err),
          details: {},
        },
      },
    };
  }
}
