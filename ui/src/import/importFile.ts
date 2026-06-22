// Format dispatch — the one place that knows file extension → parser. Adding a
// format = one parser to MoshIR + one line here.
//
// .rpp/.als parse from bytes (text / gzipped-XML). .flp is binary and parsed by a
// Python subprocess (PyFLP) that needs the file PATH, so it routes through
// importPath → parseFlp, not the byte-based importBuffer.

import { readFileSync } from "node:fs";
import { parseRpp } from "./parseRpp";
import { parseAls } from "./parseAls";
import { parseFlp } from "./parseFlp";
import { parseMidi } from "./parseMidi";
import { emptyIR, type ImportIR } from "./moshIR";

export function importBuffer(name: string, data: Buffer): ImportIR {
  const lower = name.toLowerCase();
  if (lower.endsWith(".rpp")) return parseRpp(data.toString("utf8"), name);
  if (lower.endsWith(".als")) return parseAls(data, name);
  if (lower.endsWith(".mid") || lower.endsWith(".midi")) return parseMidi(data, name);
  if (lower.endsWith(".flp")) {
    // .flp needs the file path for the PyFLP subprocess — use importPath().
    const ir = emptyIR("flp", name);
    ir.unmappable.push("FLP import needs a file path (use importPath), not a buffer");
    return ir;
  }
  throw new Error(`unsupported file: ${name} (expected .rpp, .als, .flp, .mid, or .midi)`);
}

export function importPath(path: string): ImportIR {
  if (path.toLowerCase().endsWith(".flp")) return parseFlp(path);
  return importBuffer(path, readFileSync(path));
}
