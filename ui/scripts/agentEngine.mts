// Shared headless harness for driving the REAL engine over the `Mosh --agent-server`
// stdin seam: one synchronous JSON request/response per line, prefixed @@MOSH@@ on the
// way out. Extracted from arena.mts so the arena AND the knowledge flywheel drive the
// engine through the exact same, proven path (no bypass — every mutation is one
// moshOps->execute()). Pure infra: no LLM, no scoring.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(UI_ROOT, "..");
export const MOSH_BIN = resolve(REPO, "build/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh");

export type Plan = { commands: { command: string; args?: Record<string, unknown> }[]; done?: boolean; note?: string };

/** Pull a {commands,done,note} plan out of an LLM reply (tolerates ```json fences + prose). */
export function parsePlan(content: string): Plan {
  let s = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const o = JSON.parse(s) as Plan;
    return {
      commands: Array.isArray(o.commands) ? o.commands.filter((c) => c && typeof c.command === "string") : [],
      done: !!o.done,
      note: typeof o.note === "string" ? o.note : undefined,
    };
  } catch { return { commands: [] }; }
}

/** Compact, id-rich session view for agent feedback — surfaces the EXACT ids to reuse. */
export function compactSnap(snap: any, fallbackBpm = 120): string {
  const tracks = (snap?.tracks || []).map((t: any) => {
    const clips = (t.clips || []).map((c: any) => {
      const notes = Array.isArray(c.notes) ? `,${c.notes.length}n` : "";
      const layer = c.hasRenderLayer ? `,layer:${c.renderLayer?.status ?? "?"}` : "";
      return `${c.id}(${c.type || "clip"}@${c.start}s${notes}${layer})`;
    }).join(" ");
    const plugs = (t.plugins || []).map((p: any) => `${p.index}:${p.name}`).join(",");
    return `  ${t.id} "${t.name}" ${t.volumeDb ?? 0}dB clips[${clips || "—"}]${plugs ? ` fx[${plugs}]` : ""}`;
  }).join("\n");
  return `tempo ${snap?.session?.tempo ?? fallbackBpm}\ntracks (use these EXACT ids):\n${tracks || "  (empty session)"}`;
}

/** Echo the id of whatever a command just created, so the agent can use it next turn. */
export function idHint(data: any): string {
  if (!data || typeof data !== "object") return "";
  const k = ["trackId", "clipId", "layerId"].find((x) => data[x] != null);
  return k ? ` (${k}=${data[k]})` : "";
}

/** Echo the DATA a list/browse command returned (sample paths, builtin types, plugin names). */
export function dataHint(command: string, data: any): string {
  if (!data || typeof data !== "object") return "";
  if (command === "list_samples" && Array.isArray(data.samples)) {
    const items = data.samples.slice(0, 16).map((s: any) => `      ${s.category}: ${s.name}  →  file="${s.file}"`);
    return `\n   ${data.returned} samples — call import_clip with one of these EXACT file paths:\n${items.join("\n")}`;
  }
  if (command === "list_builtins" && Array.isArray(data.plugins))
    return `\n   builtin types: ${data.plugins.map((b: any) => b.type).join(", ")}`;
  if (command === "list_plugins" && Array.isArray(data.plugins))
    return `\n   plugins: ${data.plugins.slice(0, 30).map((p: any) => p.name).join(", ")}`;
  return "";
}

/** One synchronous request/response per line over the agent-server's stdio. Each
 *  instance is a fresh, isolated engine session. */
export class Engine {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters: ((v: any) => void)[] = [];
  dead = false;

  constructor(env: Record<string, string>, bin: string = MOSH_BIN) {
    this.proc = spawn(bin, ["--agent-server"], { env: { ...process.env, ...env } });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        const m = line.indexOf("@@MOSH@@");
        if (m < 0) continue;
        let parsed: any;
        try { parsed = JSON.parse(line.slice(m + 8)); } catch { continue; }
        this.waiters.shift()?.(parsed);
      }
    });
    this.proc.on("exit", () => { this.dead = true; while (this.waiters.length) this.waiters.shift()?.({ ok: false, error: "engine exited" }); });
  }

  send(obj: any, timeoutMs = 300_000): Promise<any> {
    if (this.dead) return Promise.resolve({ ok: false, error: "engine dead" });
    return new Promise((res) => {
      const t = setTimeout(() => { this.dead = true; res({ ok: false, error: "timeout" }); try { this.proc.kill(); } catch { /* */ } }, timeoutMs);
      this.waiters.push((v) => { clearTimeout(t); res(v); });
      try { this.proc.stdin.write(JSON.stringify(obj) + "\n"); } catch { clearTimeout(t); res({ ok: false, error: "write failed" }); }
    });
  }
  exec(command: string, args: Record<string, unknown>) { return this.send({ command, args }); }
  snapshot() { return this.send({ op: "snapshot" }); }
  close() { try { this.proc.stdin.write('{"op":"quit"}\n'); } catch { /* */ } setTimeout(() => { try { this.proc.kill(); } catch { /* */ } }, 500); }
}
