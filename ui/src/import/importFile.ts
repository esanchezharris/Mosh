// Format dispatch — the one place that knows file extension → parser. Adding a
// format = one parser to MoshIR + one line here.

import { readFileSync } from "node:fs";
import { parseRpp } from "./parseRpp";
import { parseAls } from "./parseAls";
import { emptyIR, type ImportIR } from "./moshIR";

export function importBuffer(name: string, data: Buffer): ImportIR {
  const lower = name.toLowerCase();
  if (lower.endsWith(".rpp")) return parseRpp(data.toString("utf8"), name);
  if (lower.endsWith(".als")) return parseAls(data, name);
  if (lower.endsWith(".flp")) {
    const ir = emptyIR("flp", name);
    ir.unmappable.push("FLP import not implemented yet (binary; needs Python/PyFLP — Phase-1 follow-up)");
    return ir;
  }
  throw new Error(`unsupported file: ${name} (expected .rpp, .als, or .flp)`);
}

export function importPath(path: string): ImportIR {
  return importBuffer(path, readFileSync(path));
}
