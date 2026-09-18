import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { commandSchema, MiningError, type TrainingRow, type ShapeRow, type ShapeGroup } from "./types";

export const INPUT_HASHES = {
  train: "3c4e2e8b2ecc3562404fb824aa0b7dd131bd908e936c946cc8d3507adbf071eb",
  evalA: "d68ec63696ee1e88c2bb39c7ff21ae98e1dca4b60d9b762a680b33ac4019c911",
  frozen300: "1868ed3153ef7a212c72911f26f8aedb94997eb76e1e45f6df822f65ff9d7a2c",
} as const;
export const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function checkedLines(path: string, expected: string): readonly string[] {
  const bytes = readFileSync(path);
  if (hash(bytes) !== expected) throw new MiningError(`Input hash mismatch: ${path}`);
  return bytes.toString("utf8").split("\n").filter((line) => line.trim());
}
const chatSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string() })) });
const replySchema = z.object({ intent: z.string(), commands: z.array(commandSchema).default([]) });
export function trainingRows(path: string): readonly TrainingRow[] {
  return checkedLines(path, INPUT_HASHES.train).map((line, index) => {
    const chat = chatSchema.parse(JSON.parse(line));
    const role = (name: string): string => {
      const matches = chat.messages.filter((m) => m.role === name);
      if (matches.length !== 1) throw new MiningError(`Row ${index + 1}: expected one ${name} message`);
      return matches[0].content;
    };
    const reply = replySchema.parse(JSON.parse(role("assistant")));
    return { id: `sha256:${INPUT_HASHES.train}#L${index + 1}`, line: index + 1,
      utterance: role("user"), system: role("system"), intent: reply.intent, commands: reply.commands };
  });
}
const heldoutShapeSchema = z.object({ id: z.string(), goldCommandNames: z.array(z.string()) });
export function heldoutShapes(path: string, expected: string): readonly ShapeRow[] {
  // Deliberately discard every field except identity and command names at this boundary.
  return checkedLines(path, expected).map((line) => {
    const row = heldoutShapeSchema.parse(JSON.parse(line));
    return { id: row.id, shape: row.goldCommandNames };
  });
}
export function frozenSelection(rows: readonly ShapeRow[]): readonly ShapeRow[] {
  const djb2 = (s: string): number => {
    let value = 5381;
    for (let i = 0; i < s.length; i++) value = ((value << 5) + value + s.charCodeAt(i)) >>> 0;
    return value;
  };
  // Same stable sort and UTF-16 hash as ui/scripts/evalSft.mts --n 300.
  return [...rows].sort((a, b) => djb2(a.id) - djb2(b.id)).slice(0, 300);
}
export function shapes(rows: readonly ShapeRow[]): readonly ShapeGroup[] {
  const groups = new Map<string, { shape: readonly string[]; rows: string[] }>();
  for (const row of rows) {
    const key = JSON.stringify(row.shape);
    const group = groups.get(key) ?? { shape: row.shape, rows: [] };
    group.rows.push(row.id); groups.set(key, group);
  }
  const lexical = (a: readonly string[], b: readonly string[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || lexical(a.shape, b.shape));
}
export function shapeSummary(groups: readonly ShapeGroup[]) {
  const rows = groups.reduce((n, g) => n + g.rows.length, 0);
  const thresholds: Record<string, number> = {};
  let sum = 0;
  for (const [index, group] of groups.entries()) {
    sum += group.rows.length;
    for (const threshold of [50, 80, 95]) {
      if (sum >= rows * threshold / 100 && thresholds[threshold] === undefined) thresholds[threshold] = index + 1;
    }
  }
  return { rows, distinctShapes: groups.length, thresholds };
}
export function selectedGroups(groups: readonly ShapeGroup[]): readonly ShapeGroup[] {
  const total = groups.reduce((n, group) => n + group.rows.length, 0);
  const selected: ShapeGroup[] = [];
  let covered = 0;
  for (const group of groups) {
    if (!group.shape.length) continue;
    selected.push(group); covered += group.rows.length;
    if (selected.length === 40 || covered >= total * 0.8) break;
  }
  return selected;
}
