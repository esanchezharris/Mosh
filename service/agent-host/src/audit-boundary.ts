const MAX_STRING = 1_024;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;
const MAX_EVENT_BYTES = 16_384;
const REDACTED = "[REDACTED]";

const credentialPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu,
  /\b(?:sk|ek)-[A-Za-z0-9_-]{8,}\b/gu,
  /\bgh[opusr]_[A-Za-z0-9_]{8,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:SUPABASE|OPENAI|GITHUB|GH|MOSH)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*[=:]\s*\S+/giu,
];

function configuredSecrets(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(([key, value]) =>
      typeof value === "string"
      && value.length >= 6
      && /(?:SECRET|TOKEN|API_KEY|SERVICE_ROLE)/u.test(key))
    .map(([, value]) => value as string);
}

function redact(value: string, secrets: readonly string[], maximumLength = MAX_STRING): string {
  let safe = value;
  for (const pattern of credentialPatterns) safe = safe.replace(pattern, REDACTED);
  for (const secret of secrets) safe = safe.split(secret).join(REDACTED);
  return safe.slice(0, maximumLength);
}

export function sanitizeHostedText(
  value: string,
  maximumLength: number,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return redact(
    value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ""),
    configuredSecrets(environment),
    maximumLength,
  );
}

function redactFailureText(value: string): string {
  return value
    .replace(/\bAuthorization\s*:\s*(?:Bearer\s+)?\S+/giu, REDACTED)
    .replace(
      /\/(?:Users|Volumes|private|tmp|var\/folders|Applications|Library|opt|usr\/local)\/[^\s"'`,;)]+/gu,
      "[REDACTED_PATH]",
    );
}

function bounded(
  value: unknown,
  secrets: readonly string[],
  depth: number,
): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => bounded(item, secrets, depth + 1));
  }
  if (typeof value !== "object" || value === null) return null;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_ARRAY)
      .map(([key, item]) => [redact(key, secrets), bounded(item, secrets, depth + 1)]),
  );
}

export function sanitizeAuditData(
  data: Readonly<Record<string, unknown>>,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const safe = bounded(data, configuredSecrets(environment), 0) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(safe), "utf8") <= MAX_EVENT_BYTES) return safe;
  return { truncated: true };
}

export function safeFailure(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): { code: string; message: string } {
  const candidate = error instanceof Error ? error : new Error(fallbackMessage);
  const rawCode = error && typeof error === "object" && "code" in error
    ? error.code
    : fallbackCode;
  const sanitized = sanitizeAuditData({
    code: typeof rawCode === "string" ? rawCode : fallbackCode,
    message: candidate.message || fallbackMessage,
  });
  const code = redactFailureText(
    typeof sanitized.code === "string" ? sanitized.code : fallbackCode,
  );
  const message = redactFailureText(
    typeof sanitized.message === "string" ? sanitized.message : fallbackMessage,
  );
  return {
    code: code || fallbackCode,
    message: message || fallbackMessage,
  };
}
