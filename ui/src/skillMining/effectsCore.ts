import { array, record } from "./types";
import type { Json } from "./types";

export type Effect = { readonly status: "passed" | "failed" | "unverified"; readonly reason: string };
export type Obj = Record<string, Json>;
export const passed = (reason = "Requested snapshot effect observed"): Effect => ({ status: "passed", reason });
export const failed = (reason: string): Effect => ({ status: "failed", reason });
export const unverified = (reason: string): Effect => ({ status: "unverified", reason });
export function equal(a: Json | undefined, b: Json | undefined): boolean {
  if (typeof a === "number" && typeof b === "number") return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-5;
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
}
export const without = (value: Obj, keys: readonly string[]): Obj => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
export const tracks = (snapshot: Json): Obj[] => array(record(snapshot).tracks).map(record);
export const clips = (snapshot: Json): Obj[] => tracks(snapshot).flatMap(track => array(track.clips).map(clip => ({ ...record(clip), trackId: track.id })));
export const byId = (items: readonly Obj[], id: Json | undefined): Obj | undefined => id === undefined ? undefined : items.find(item => item.id === id);
export function unchangedOthers(before: readonly Obj[], after: readonly Obj[], ids: readonly Json[]): boolean {
  const left = before.filter(item => !ids.includes(item.id));
  const right = after.filter(item => !ids.includes(item.id));
  return left.length === right.length && left.every(item => equal(item, byId(right, item.id)));
}
export function fields(before: Obj | undefined, after: Obj | undefined, expected: Obj): Effect {
  if (!before || !after) return failed("Addressed object is missing before or after the command");
  if (Object.keys(expected).length === 0) return unverified("No observable requested field supplied");
  for (const [key, value] of Object.entries(expected)) {
    if (after[key] === undefined || before[key] === undefined) return unverified(`Snapshot field ${key} is missing`);
    if (!equal(after[key], value)) return failed(`Requested ${key} value was not observed`);
  }
  return Object.keys(expected).some(key => !equal(before[key], after[key])) ? passed() : unverified("Requested state was already present; no effect observed");
}
export function created(before: readonly Obj[], after: readonly Obj[], expected: Obj): Effect {
  const added = after.filter(item => !byId(before, item.id));
  if (added.length !== 1 || !added[0].id || !unchangedOthers(before, after, [added[0].id])) return failed("Expected exactly one new object with existing objects preserved");
  for (const [key, value] of Object.entries(expected)) {
    if (added[0][key] === undefined) return unverified(`Created object field ${key} is missing`);
    if (!equal(added[0][key], value)) return failed(`Created object has incorrect ${key}`);
  }
  return passed();
}
export function removed(before: readonly Obj[], after: readonly Obj[], id: Json | undefined): Effect {
  if (id === undefined || !byId(before, id) || byId(after, id) || !unchangedOthers(before, after, [id])) return failed("Expected only the addressed object to be removed");
  return passed();
}
export const pick = (source: Obj, keys: readonly string[]): Obj => Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
