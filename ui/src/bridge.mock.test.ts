import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __resetMockForTests, mockExecute, mockSnapshot } from "./bridge.mock";
import type { CommandResult, Snapshot } from "./types";

// ── Mock-vs-contract drift guard ─────────────────────────────────────────────
// bridge.mock.ts is the in-memory dev backend (Vite dev / no JUCE). Its dispatch
// ends in `default: return ok(command)` — so a command the UI sends but the mock
// does NOT explicitly handle returns a SILENT fake success: the dev UI looks like
// it worked while nothing happened. This test makes that drift loud: every command
// the UI dispatches must be either explicitly cased in the mock OR listed below as a
// knowing, documented exception. Add a UI command without doing one of those → red.

const SRC = path.dirname(fileURLToPath(import.meta.url)); // ui/src
const MOCK = path.join(SRC, "bridge.mock.ts");

/** Commands intentionally allowed to fall through to the mock's default-ok. */
const ALLOWLIST = new Set<string>([
  // Live-only data with no dev-mock state to mutate (UI degrades gracefully):
  "rescan_plugins",
  "import_clip_data", // dev imports via the import_clip path; bytes-over-bridge is native-only
  // KNOWN DEV-MOCK GAPS — these DO mutate session state, so the dev mock no-ops
  // where the real backend would change the arrangement. Tracked here so the guard
  // stays green; give them real mock cases when dev-mode fidelity matters.
  "paste_clip",
  // (create_group_track is dispatched by the configurable keymap's GROUP action and
  //  now has a real mock case — so it's intentionally NOT allowlisted.)
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "juce") continue; // vendored
      out.push(...listSourceFiles(p));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== "bridge.mock.ts") {
      out.push(p);
    }
  }
  return out;
}

function uiDispatchedCommands(): Set<string> {
  const cmds = new Set<string>();
  // exec("name", …) · command: "name" · execLatest("key", "name", …) — the command
  // is the 2nd arg there. Templates with vars are skipped (only literals are checkable).
  const patterns = [
    /\bexec\(\s*["'`]([a-z_][a-z_0-9]*)["'`]/g,
    /\bcommand:\s*["'`]([a-z_][a-z_0-9]*)["'`]/g,
    /\bexecLatest\(\s*["'`][^"'`]*["'`]\s*,\s*["'`]([a-z_][a-z_0-9]*)["'`]/g,
  ];
  for (const file of listSourceFiles(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const re of patterns) {
      for (const match of text.matchAll(re)) cmds.add(match[1]);
    }
  }
  return cmds;
}

function mockCasedCommands(): Set<string> {
  const text = fs.readFileSync(MOCK, "utf8");
  const cased = new Set<string>();
  for (const match of text.matchAll(/\bcase\s+["']([a-z_][a-z_0-9]*)["']/g)) cased.add(match[1]);
  return cased;
}

describe("bridge.mock contract drift", () => {
  it("every command the UI dispatches is cased in the mock (or explicitly allowlisted)", () => {
    const ui = uiDispatchedCommands();
    const cased = mockCasedCommands();
    expect(ui.size).toBeGreaterThan(20); // sanity: extraction actually found commands
    const unhandled = [...ui].filter((c) => !cased.has(c) && !ALLOWLIST.has(c)).sort();
    expect(
      unhandled,
      `These commands are dispatched by the UI but silently hit the mock's default-ok ` +
        `(add a case in bridge.mock.ts or, if intentional, to ALLOWLIST):\n  ${unhandled.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries (each is still referenced by the UI)", () => {
    const ui = uiDispatchedCommands();
    const stale = [...ALLOWLIST].filter((c) => !ui.has(c)).sort();
    expect(stale, `ALLOWLIST entries no longer dispatched by the UI — remove them:\n  ${stale.join("\n  ")}`).toEqual(
      [],
    );
  });
});

describe("bridge.mock Mosh FX built-ins", () => {
  it("lists the native Mosh FX suite in the built-in catalog", async () => {
    __resetMockForTests();
    const res = await mockExecute<CommandResult<{ plugins: Array<{ type: string; category: string; isInstrument: boolean }> }>>({
      command: "list_builtins",
      args: {},
    });

    expect(res.ok).toBe(true);
    const moshFx = res.data?.plugins.filter((p) => p.category === "Mosh FX") ?? [];
    expect(moshFx.map((p) => p.type).sort()).toEqual(["moshAutoTune", "moshOTT", "moshXFeedback"].sort());
    expect(moshFx.every((p) => !p.isInstrument)).toBe(true);
  });

  it("loads X-FDBK through the mock seam with additive moshFx readout", async () => {
    __resetMockForTests();
    const created = await mockExecute<CommandResult<{ trackId: string }>>({
      command: "create_track",
      args: { name: "Feedback Bus" },
    });
    const trackId = created.data?.trackId ?? "";
    expect(trackId).not.toBe("");

    const loaded = await mockExecute<CommandResult>({
      command: "load_builtin",
      args: { trackId, type: "moshXFeedback" },
    });
    expect(loaded.ok).toBe(true);

    const snap = await mockSnapshot<Snapshot>();
    const track = snap.tracks.find((t) => t.id === trackId);
    const plugin = track?.plugins?.find((p) => p.type === "moshXFeedback");
    expect(plugin?.params.map((p) => p.name)).toEqual([
      "Sensitivity",
      "Max Cuts",
      "Max Depth",
      "Release",
      "Auto Suppress",
      "Mix",
      "Output",
    ]);
    expect(plugin?.moshFx?.kind).toBe("feedback");
    expect(plugin?.moshFx?.candidates?.[0]?.frequencyHz).toBeGreaterThan(1000);
    expect(plugin?.moshFx?.activeCuts).toEqual([]);
  });

  it("keeps mock Mosh FX readouts aligned with the native additive schema", async () => {
    __resetMockForTests();
    const created = await mockExecute<CommandResult<{ trackId: string }>>({
      command: "create_track",
      args: { name: "Mosh FX Readouts" },
    });
    const trackId = created.data?.trackId ?? "";

    for (const type of ["moshAutoTune", "moshOTT"] as const) {
      const loaded = await mockExecute<CommandResult>({
        command: "load_builtin",
        args: { trackId, type },
      });
      expect(loaded.ok).toBe(true);
    }

    const snap = await mockSnapshot<Snapshot>();
    const plugins = snap.tracks.find((t) => t.id === trackId)?.plugins ?? [];
    const autoTune = plugins.find((p) => p.type === "moshAutoTune")?.moshFx;
    const ott = plugins.find((p) => p.type === "moshOTT")?.moshFx;

    expect(autoTune).toMatchObject({
      kind: "autotune",
      inputHz: expect.any(Number),
      targetHz: expect.any(Number),
      correctionCents: expect.any(Number),
      confidence: expect.any(Number),
    });
    expect(ott).toMatchObject({
      kind: "ott",
      amount: expect.any(Number),
      timeMs: expect.any(Number),
    });
  });
});
