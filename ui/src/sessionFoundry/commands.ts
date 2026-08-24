import { lstat, statfs } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const SESSION_CAPTURE_DEFAULTS_V1 = {
  maximumMinutes: 120,
  maxChunkMinutes: 15,
  minimumFreeBytes: 30 * 1024 * 1024 * 1024,
} as const;

export type CaptureCommandV1 = {
  readonly kind: "capture";
  readonly goal: string;
  readonly abletonSetPath: string;
  readonly maxMinutes: number;
  readonly chunkMinutes: number;
};

export type StatusCommandV1 = {
  readonly kind: "status";
  readonly sessionId: string;
};

export type SessionFoundryCommandV1 = CaptureCommandV1 | StatusCommandV1;

export type CaptureLaunchContextV1 = {
  readonly sessionId: string;
  readonly sessionDirectory: string;
  readonly repoRoot: string;
  readonly helperOverride: string | null;
};

export type CaptureLaunchV1 = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export type CapturePreflightResultV1 =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "set_missing" | "set_not_regular" | "set_not_owner" | "set_not_als" | "insufficient_disk";
    };

export class SessionFoundryUsageError extends Error {
  readonly name = "SessionFoundryUsageError";
}

type FlagMapV1 = Readonly<Record<string, string>>;

function parseFlagsV1(args: readonly string[]): FlagMapV1 {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new SessionFoundryUsageError(`invalid flag sequence near ${flag ?? "end of command"}`);
    }
    if (Object.prototype.hasOwnProperty.call(flags, flag)) {
      throw new SessionFoundryUsageError(`duplicate flag: ${flag}`);
    }
    flags[flag] = value;
  }
  return flags;
}

function requireFlagV1(flags: FlagMapV1, flag: string): string {
  const value = flags[flag];
  if (value === undefined || value.trim().length === 0) {
    throw new SessionFoundryUsageError(`missing ${flag}`);
  }
  return value;
}

function parseBoundedIntegerV1(value: string, flag: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new SessionFoundryUsageError(`${flag} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function rejectUnknownFlagsV1(flags: FlagMapV1, allowed: readonly string[]): void {
  for (const flag of Object.keys(flags)) {
    if (!allowed.includes(flag)) {
      throw new SessionFoundryUsageError(`unknown flag: ${flag}`);
    }
  }
}

export function parseSessionFoundryArgsV1(args: readonly string[]): SessionFoundryCommandV1 {
  const command = args[0];
  const flags = parseFlagsV1(args.slice(1));
  if (command === "capture") {
    rejectUnknownFlagsV1(flags, ["--goal", "--set", "--max-minutes", "--chunk-minutes"]);
    const abletonSetPath = requireFlagV1(flags, "--set");
    if (!isAbsolute(abletonSetPath)) {
      throw new SessionFoundryUsageError("--set must be an absolute path");
    }
    return {
      kind: "capture",
      goal: requireFlagV1(flags, "--goal"),
      abletonSetPath,
      maxMinutes: parseBoundedIntegerV1(
        flags["--max-minutes"] ?? String(SESSION_CAPTURE_DEFAULTS_V1.maximumMinutes),
        "--max-minutes",
        SESSION_CAPTURE_DEFAULTS_V1.maximumMinutes,
      ),
      chunkMinutes: parseBoundedIntegerV1(
        flags["--chunk-minutes"] ?? String(SESSION_CAPTURE_DEFAULTS_V1.maxChunkMinutes),
        "--chunk-minutes",
        SESSION_CAPTURE_DEFAULTS_V1.maxChunkMinutes,
      ),
    };
  }
  if (command === "status") {
    rejectUnknownFlagsV1(flags, ["--session"]);
    return { kind: "status", sessionId: requireFlagV1(flags, "--session") };
  }
  throw new SessionFoundryUsageError(`unknown command: ${command ?? ""}`);
}

export function buildCaptureLaunchV1(command: CaptureCommandV1, context: CaptureLaunchContextV1): CaptureLaunchV1 {
  const helperArgs = [
    "capture",
    "--session-id",
    context.sessionId,
    "--session-directory",
    context.sessionDirectory,
    "--goal",
    command.goal,
    "--set",
    command.abletonSetPath,
    "--max-minutes",
    String(command.maxMinutes),
    "--chunk-minutes",
    String(command.chunkMinutes),
  ] as const;
  if (context.helperOverride !== null) {
    return { executable: context.helperOverride, args: helperArgs, env: {} };
  }
  return {
    executable: "swift",
    args: ["run", "--package-path", join(context.repoRoot, "tools/session-foundry-capture"), "MoshSessionCapture", ...helperArgs],
    env: {},
  };
}

export async function defaultFreeBytesV1(path: string): Promise<number> {
  const filesystem = await statfs(path);
  return filesystem.bavail * filesystem.bsize;
}

export async function preflightCaptureV1(
  abletonSetPath: string,
  freeBytes: (path: string) => Promise<number> = defaultFreeBytesV1,
): Promise<CapturePreflightResultV1> {
  if (!abletonSetPath.toLocaleLowerCase("en-US").endsWith(".als")) {
    return { ok: false, code: "set_not_als" };
  }
  let metadata;
  try {
    metadata = await lstat(abletonSetPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: false, code: "set_missing" };
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    return { ok: false, code: "set_not_regular" };
  }
  const ownerUid = process.getuid?.();
  if (ownerUid !== undefined && metadata.uid !== ownerUid) {
    return { ok: false, code: "set_not_owner" };
  }
  const available = await freeBytes(abletonSetPath);
  if (available < SESSION_CAPTURE_DEFAULTS_V1.minimumFreeBytes) {
    return { ok: false, code: "insufficient_disk" };
  }
  return { ok: true };
}
