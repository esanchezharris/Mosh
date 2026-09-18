import { jsonSchema, type Command, type Json } from "./types";

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function exactCommands(a: readonly Command[], b: readonly Command[]): boolean {
  return canonical(jsonSchema.parse(a)) === canonical(jsonSchema.parse(b));
}
