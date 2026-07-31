import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parseValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === `"` || first === `'`) && trimmed.at(-1) === first)
      return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

export function readOwnerOpenAIKey(
  environment: NodeJS.ProcessEnv = process.env,
  filePath = join(homedir(), ".config", "mosh", "env"),
): string | undefined {
  const inherited = environment.OPENAI_API_KEY?.trim();
  if (inherited) return inherited;

  try {
    const metadata = statSync(filePath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) return undefined;
    for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = line.replace(/^export\s+/, "");
      const separator = assignment.indexOf("=");
      if (separator < 1 || assignment.slice(0, separator).trim() !== "OPENAI_API_KEY") continue;
      const value = parseValue(assignment.slice(separator + 1));
      return value || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
