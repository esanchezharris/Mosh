// CAP-TRK-002 (#613) — the drift guard on the track-icon vocabulary.
//
// `set_track_icon` validates membership, not just form (see src/state/TrackIcons.h for why
// icons diverge from colour here). That buys honesty — an unknown name is refused rather
// than persisted as an invisible no-op — at the cost of a list that now exists in two
// languages. Two ways that can rot, and each is a bug a user would actually meet:
//
//   engine has a name the UI doesn't  → an agent (or an older project file) sets a valid
//                                       icon and the header renders the type default. The
//                                       value is real and correct; the shell just can't
//                                       draw it.
//   UI has a name the engine doesn't  → the producer clicks a swatch in the picker and the
//                                       command comes back an error. The one surface the
//                                       whole ticket is about, broken on click.
//
// So the guard reads the C++ header as text at test time and compares BOTH directions,
// same idiom as txnSafeRegistry.test.ts on TransactionSafe.h. It also checks the third
// way to ship a dead entry: a name in both lists with no glyph behind it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACK_ICONS, TRACK_ICON_GLYPHS } from "./trackIcons";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/v2
const header = readFileSync(resolve(here, "../../../src/state/TrackIcons.h"), "utf8");

/** The `std::set<juce::String> known { ... }` body of trackIcons::registry(). */
function engineRegistry(): string[] {
  const at = header.indexOf("known {");
  const open = header.indexOf("{", at);
  const close = header.indexOf("};", open);
  expect(at, "trackIcons::registry()'s `known` set not found in TrackIcons.h").toBeGreaterThan(-1);
  return [...header.slice(open, close).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]).sort();
}

describe("track icon vocabulary (#613)", () => {
  it("the shipped palette and the engine registry are the same set", () => {
    // Sorted comparison, not length or subset: a swap (one added, one removed) keeps the
    // count identical and is exactly the edit a palette reshuffle makes.
    expect([...TRACK_ICONS].sort()).toEqual(engineRegistry());
  });

  it("the engine registry is non-trivial, so the comparison above cannot pass vacuously", () => {
    // Without this, a regex that silently matched nothing would make the test above
    // compare [] to [] and go green while both lists were unread.
    expect(engineRegistry().length).toBeGreaterThanOrEqual(8);
  });

  it("every offered icon has a glyph to draw", () => {
    // A name in both lists with no entry here reaches the picker as an empty button:
    // clickable, persisted, and invisible.
    for (const name of TRACK_ICONS) expect(TRACK_ICON_GLYPHS[name], `no glyph for "${name}"`).toBeTruthy();
  });

  it("names are lowercase slugs — the engine normalizes to lowercase before matching", () => {
    for (const name of TRACK_ICONS) expect(name).toMatch(/^[a-z0-9_]+$/);
  });
});
