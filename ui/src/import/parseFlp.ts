// FL Studio .flp → MoshIR, via the PyFLP carve (service/flp/).
//
// .flp is binary; PyFLP parses it but only on Python ≤3.10, so it lives in a
// dedicated venv (service/flp/.venv) built by service/flp/setup-flp.sh. This
// frontend shells out to service/flp/flp_cli.py (which emits a MoshIR-shaped
// session as JSON) and wraps the result into an ImportIR — the same shape the
// RPP/ALS parsers produce, fed to the same emitter/verifier.
//
// This is the ONLY importer that spawns a subprocess; it's a Node-only path (the
// browser never imports project files). When the venv is absent it degrades
// gracefully: an empty IR that logs how to enable FLP import.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyIR, type ImportIR, type IRTrack } from "./moshIR";

const FLP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../service/flp");

// Locate the venv interpreter: env override first (FLP_PY), then the .flp.env file
// that setup-flp.sh writes. Returns null when neither resolves to a real file.
function resolveFlpPy(): string | null {
  let py = process.env.FLP_PY;
  if (!py) {
    try {
      const m = readFileSync(join(FLP_DIR, ".flp.env"), "utf8").match(/FLP_PY=["']?([^"'\n]+)["']?/);
      if (m) py = m[1];
    } catch {
      /* no env file — venv not set up */
    }
  }
  if (!py) return null;
  try {
    return statSync(py).isFile() ? py : null;
  } catch {
    return null;
  }
}

export function parseFlp(path: string): ImportIR {
  const ir = emptyIR("flp", path);

  const py = resolveFlpPy();
  if (!py) {
    ir.unmappable.push("FLP import unavailable — run service/flp/setup-flp.sh (PyFLP venv)");
    return ir;
  }

  const res = spawnSync(py, [join(FLP_DIR, "flp_cli.py"), path], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024, // big projects → many notes
  });
  if (res.error || res.status !== 0) {
    const why = (res.stderr || res.error?.message || "unknown error").toString().trim().split("\n").pop();
    ir.unmappable.push(`FLP parse failed: ${why}`);
    return ir;
  }

  let parsed: { ok?: boolean; error?: string; session?: { tempo?: number; tracks?: IRTrack[] }; unmappable?: string[] };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    ir.unmappable.push("FLP parse: flp_cli.py did not emit valid JSON");
    return ir;
  }
  if (!parsed.ok) {
    ir.unmappable.push(`FLP parse: ${parsed.error ?? "unknown error"}`);
    return ir;
  }

  if (typeof parsed.session?.tempo === "number") ir.session.tempo = parsed.session.tempo;
  ir.session.tracks = Array.isArray(parsed.session?.tracks)
    ? parsed.session.tracks.map((t) => ({ ...t, clips: Array.isArray(t.clips) ? t.clips : [] }))
    : [];
  if (Array.isArray(parsed.unmappable)) ir.unmappable.push(...parsed.unmappable);
  return ir;
}
