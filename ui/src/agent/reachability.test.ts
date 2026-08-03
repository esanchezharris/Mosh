import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Guard for docs/verification/REACHABILITY.md — the L3 lane's ledger (DAW-parity P5).
// The ledger maps user-facing capabilities to v2 affordances + covering e2e specs; this
// test keeps it from rotting: a renamed testid, a deleted spec, or a "gap" row whose
// backlog item has shipped each fail the cheap gate. Parsing is deliberately strict —
// if the table format drifts, THIS fails loudly rather than silently checking nothing.

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const LEDGER = join(repo, "docs", "verification", "REACHABILITY.md");
const E2E_DIR = join(repo, "ui", "e2e");
const BACKLOG = join(repo, "scripts", "daw-conformance", "parity_backlog.jsonl");
const SRC_DIR = join(repo, "ui", "src");

interface Row {
  capability: string;
  commands: string[];
  status: string;
  selector: string;
  spec: string;
}

function parseLedger(): Row[] {
  const lines = readFileSync(LEDGER, "utf8").split("\n");
  const rows: Row[] = [];
  let inTable = false;
  for (const line of lines) {
    if (/^\|\s*capability\s*\|/.test(line)) { inTable = true; continue; }
    if (inTable && /^\|[-\s|]+\|$/.test(line.trim())) continue;
    if (inTable) {
      if (!line.trim().startsWith("|")) { inTable = false; continue; }
      const cells = line.split("|").map((c) => c.trim());
      // "| a | b | c | d | e |" splits into ["", a, b, c, d, e, ""]
      if (cells.length < 7) continue;
      rows.push({
        capability: cells[1],
        commands: cells[2].split(",").map((c) => c.trim()).filter(Boolean),
        status: cells[3],
        selector: cells[4],
        spec: cells[5],
      });
    }
  }
  return rows;
}

/** Every file under ui/src (source only), concatenated lazily for selector grepping. */
let srcBlob: string | null = null;
function uiSource(): string {
  if (srcBlob !== null) return srcBlob;
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(name)) parts.push(readFileSync(p, "utf8"));
    }
  };
  walk(SRC_DIR);
  srcBlob = parts.join("\n");
  return srcBlob;
}

function backlogStatuses(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(BACKLOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.id) map.set(d.id, d.status);
    } catch { /* model_lint owns backlog validity */ }
  }
  return map;
}

describe("REACHABILITY ledger", () => {
  const rows = parseLedger();

  it("parses a non-trivial table (format-drift tripwire)", () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const r of rows) {
      expect(["reachable", "hardware"].includes(r.status) || r.status.startsWith("gap:"),
        `${r.capability}: unknown status '${r.status}'`).toBe(true);
    }
  });

  it("every reachable testid: selector exists in ui/src", () => {
    for (const r of rows) {
      if (r.status !== "reachable") continue;
      if (r.selector.startsWith("testid:")) {
        const id = r.selector.slice("testid:".length);
        expect(uiSource().includes(id), `${r.capability}: data-testid '${id}' not found in ui/src`).toBe(true);
      } else if (r.selector.startsWith("class:")) {
        const cls = r.selector.slice("class:".length);
        expect(uiSource().includes(cls), `${r.capability}: className '${cls}' not found in ui/src`).toBe(true);
      }
      // role: selectors are label-addressed — not grepped by design.
    }
  });

  it("every named spec exists in ui/e2e (gap rows ship their fixme spec too)", () => {
    for (const r of rows) {
      if (r.spec === "—" || r.spec === "-") continue;
      expect(existsSync(join(E2E_DIR, r.spec)), `${r.capability}: spec '${r.spec}' missing from ui/e2e/`).toBe(true);
    }
  });

  it("every gap: row references a LIVE backlog item (a shipped item must flip its row)", () => {
    const statuses = backlogStatuses();
    for (const r of rows) {
      if (!r.status.startsWith("gap:")) continue;
      const id = r.status.slice("gap:".length);
      expect(statuses.has(id), `${r.capability}: backlog item '${id}' not in backlog.jsonl`).toBe(true);
      expect(statuses.get(id) !== "done",
        `${r.capability}: backlog item '${id}' is DONE — flip this row to 'reachable' (and un-fixme its spec)`).toBe(true);
    }
  });

  it("the core user-facing mutation commands all appear in some row", () => {
    // The curated floor: commands a producer reaches for daily. (Full-catalog totality
    // is the coverage ledger's job — scripts/daw-conformance/coverage_check.py.)
    const CORE = [
      "set_clip_fade", "set_clip_reverse", "normalize_clip", "set_clip_loop",
      "set_clip_gain", "export_audio", "export_stems", "set_master_volume",
      "load_master_builtin", "create_bus", "add_send", "set_clip_warp",
      "stretch_clip", "quantize_notes", "set_tempo", "set_time_signature",
      "set_key", "set_count_in", "arm_track", "set_current_take",
      "set_track_automation_mode", "delete_time_range", "create_group_track",
    ];
    const seen = new Set(rows.flatMap((r) => r.commands));
    for (const c of CORE) {
      expect(seen.has(c), `core command '${c}' has no reachability row`).toBe(true);
    }
  });
});
