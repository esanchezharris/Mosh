// Binding a hand-seeded (or future YouTube-mined) RECIPE card's commands to a live
// session: cards carry session-agnostic `$token` placeholders (e.g. "$hatsClipId");
// the base builder captures the real ids and bindRecipe substitutes them. Pure +
// dependency-free so it unit-tests and the harness (recipeBase.mts) imports it.

export type RecipeCommand = { command: string; args: Record<string, unknown> };

// Resolve one value: a string of the exact form "$name" → bindings[name] (any type,
// e.g. a number paramIndex); arrays/objects are walked; everything else is returned
// as-is. An unbound "$name" stays literal so downstream validateCommand trips it.
// Exported so the conformance dispatcher (check.ts) resolves a CheckSpec's $token refs
// with the SAME semantics a recipe's command args use — one source of truth.
export function resolveValue(v: unknown, bindings: Record<string, unknown>): unknown {
  if (typeof v === "string" && v.startsWith("$")) {
    const key = v.slice(1);
    return key in bindings ? bindings[key] : v;
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, bindings));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = resolveValue(val, bindings);
    return out;
  }
  return v;
}

export function bindRecipe(commands: RecipeCommand[], bindings: Record<string, unknown>): RecipeCommand[] {
  return commands.map((c) => ({ command: c.command, args: resolveValue(c.args ?? {}, bindings) as Record<string, unknown> }));
}
