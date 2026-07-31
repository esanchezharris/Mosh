import { spawn } from "node:child_process";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface CommandRunner {
  run(command: string, args: readonly string[], cwd?: string): Promise<CommandResult>;
}

export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw codedError("github_invalid_response", "Command returned invalid JSON");
  }
}

export class NodeCommandRunner implements CommandRunner {
  async run(command: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        ...(cwd ? { cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length < 2_000_000) stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < 100_000) stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  }
}
