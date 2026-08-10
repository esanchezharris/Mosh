import type { CommandResult } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function appliedFailure(result: CommandResult, fallback: string): string | null {
  if (!result.ok || !isRecord(result.data) || result.data.applied !== false) return null;
  return typeof result.data.reason === "string" && result.data.reason.trim()
    ? result.data.reason
    : fallback;
}
