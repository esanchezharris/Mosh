// Dump the TS recipeVerifier's verdict on the 24 red-team fooling recipes + a couple of
// hand-built good/degraded recipes → a parity golden the Python port must reproduce exactly.
// This is the anti-drift guarantee: the GRPO recipe-reward (Python) == the validated TS reward.
import { writeFileSync } from "node:fs";
import { verifyRecipe, type Recipe } from "../src/agent/recipeVerifier";
import fooling from "../src/agent/__fixtures__/foolingRecipes.json";

// a clean, musical reference beat (matches the spirit of the TS test's great())
const GOOD: Recipe = {
  tempo: 140, bars: 2, key: { tonic: "A", mode: "minor" },
  tracks: [
    { name: "Drums", role: "drums", notes: [
      { pitch: 36, start: 0, length: 0.25, velocity: 118 }, { pitch: 36, start: 2.5, length: 0.25, velocity: 96 },
      { pitch: 36, start: 4, length: 0.25, velocity: 120 }, { pitch: 36, start: 6.75, length: 0.25, velocity: 90 },
      { pitch: 38, start: 1, length: 0.25, velocity: 110 }, { pitch: 38, start: 3, length: 0.25, velocity: 102 },
      { pitch: 38, start: 5, length: 0.25, velocity: 112 }, { pitch: 38, start: 7, length: 0.25, velocity: 100 },
      { pitch: 42, start: 0, length: 0.25, velocity: 80 }, { pitch: 42, start: 0.5, length: 0.25, velocity: 64 },
      { pitch: 42, start: 1, length: 0.25, velocity: 92 }, { pitch: 42, start: 1.5, length: 0.25, velocity: 60 },
      { pitch: 42, start: 2, length: 0.25, velocity: 84 }, { pitch: 42, start: 3, length: 0.25, velocity: 70 },
      { pitch: 42, start: 4, length: 0.25, velocity: 88 }, { pitch: 42, start: 4.5, length: 0.25, velocity: 62 },
      { pitch: 42, start: 5.5, length: 0.25, velocity: 90 }, { pitch: 42, start: 6, length: 0.25, velocity: 76 },
      { pitch: 42, start: 7, length: 0.25, velocity: 86 }, { pitch: 42, start: 7.5, length: 0.25, velocity: 58 },
    ]},
    { name: "808", role: "bass", notes: [
      { pitch: 33, start: 0, length: 1, velocity: 110 }, { pitch: 33, start: 1.5, length: 0.5, velocity: 92 },
      { pitch: 40, start: 3, length: 1, velocity: 104 }, { pitch: 36, start: 4, length: 1, velocity: 108 },
      { pitch: 43, start: 5.5, length: 0.5, velocity: 88 }, { pitch: 38, start: 6.5, length: 1.5, velocity: 100 },
    ]},
    { name: "Lead", role: "melody", notes: [
      { pitch: 69, start: 0, length: 0.5, velocity: 100 }, { pitch: 72, start: 0.5, length: 0.5, velocity: 86 },
      { pitch: 71, start: 1, length: 0.5, velocity: 94 }, { pitch: 76, start: 2, length: 1, velocity: 104 },
      { pitch: 74, start: 3, length: 0.5, velocity: 90 }, { pitch: 72, start: 3.5, length: 0.5, velocity: 82 },
      { pitch: 69, start: 4, length: 0.5, velocity: 98 }, { pitch: 67, start: 4.5, length: 0.5, velocity: 84 },
      { pitch: 72, start: 5, length: 1, velocity: 96 }, { pitch: 76, start: 6, length: 0.5, velocity: 102 },
      { pitch: 77, start: 6.5, length: 0.5, velocity: 88 }, { pitch: 74, start: 7, length: 1, velocity: 92 },
    ]},
  ],
};

const cands = (fooling as { candidates: { name: string; lens?: string; recipe: Recipe }[] }).candidates;
const out: Record<string, unknown> = { good: verdictOf(GOOD) };
function verdictOf(r: Recipe) { const v = verifyRecipe(r); return { total: v.total, dims: v.dims }; }
const items: Record<string, unknown>[] = [{ name: "good", lens: "reference", recipe: GOOD, ...verdictOf(GOOD) }];
for (const c of cands) items.push({ name: c.name, lens: c.lens ?? "?", recipe: c.recipe, ...verdictOf(c.recipe) });

const path = process.argv[2] ?? "/private/tmp/claude-501/verifier-parity.json";
writeFileSync(path, JSON.stringify({ items }, null, 1));
console.log(`wrote ${items.length} parity records → ${path}`);
console.log(`good total ${(out.good as any).total.toFixed(4)}; fooling max ${Math.max(...cands.map((c) => verifyRecipe(c.recipe).total)).toFixed(4)}`);
