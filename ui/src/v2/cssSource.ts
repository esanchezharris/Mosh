// The v2 stylesheet, reconstructed as text for the guards that read it.
//
// shell.css used to BE the stylesheet, so five guards simply did
// `readFileSync(".../shell.css")`. It is now an @import manifest over
// ui/src/v2/css/*.css, so that read returns eleven @import lines and nothing
// else — and a guard that greps an empty haystack for a forbidden pattern
// PASSES. Every `expect(css).not.toContain(...)` in this repo would have gone
// permanently, silently green.
//
// So the concatenation is centralised here, in the manifest's order, and it is
// defensive on purpose: a missing partition or a suspiciously small result
// THROWS rather than returning a short string. A guard that cannot read its
// subject must fail loudly, never pass quietly. That is the whole point of
// this module, and cssSource.test.ts RED-proves it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Order matters and mirrors the @import list in shell.css exactly: CSS is
// order-dependent, so a guard reasoning about the cascade (last-wins, theme
// overrides) must see the partitions in the order the browser does.
export const PARTITION_FILES = [
  "00-tokens.css",
  "10-launch.css",
  "20-topbar.css",
  "30-arrangement.css",
  "40-rail.css",
  "50-composer.css",
  "60-docks.css",
  "70-notices.css",
  "80-plugin-picker.css",
  "90-focus-rings.css",
  "95-fms-agent.css",
  "96-lora-lab.css",
] as const;

// The pre-split sheet was 105_061 bytes. A floor well under that still catches
// the failure that matters (a glob that matched nothing, or a partition list
// that silently lost entries) without breaking the moment someone legitimately
// deletes a rule. If a real edit ever trips this, the fix is to look at why the
// sheet halved — not to lower the number.
const MIN_BYTES = 60_000;

const here = dirname(fileURLToPath(import.meta.url));

/** The full v2 stylesheet as one string, partitions concatenated in cascade order. */
export function readShellCss(): string {
  const parts = PARTITION_FILES.map((f) => {
    const p = join(here, "css", f);
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch (e) {
      throw new Error(`cssSource: partition missing: ${p} — shell.css's @import list and PARTITION_FILES have diverged (${e})`);
    }
    if (!text.trim()) throw new Error(`cssSource: partition is empty: ${p}`);
    return text;
  });
  const css = parts.join("");
  if (css.length < MIN_BYTES) {
    throw new Error(
      `cssSource: reconstructed sheet is ${css.length} bytes, under the ${MIN_BYTES} floor. ` +
        `A truncated sheet makes every not.toContain() guard pass vacuously — failing instead.`,
    );
  }
  return css;
}

/** The @import manifest itself — for the guard that checks it against PARTITION_FILES. */
export function readShellManifest(): string {
  return readFileSync(join(here, "shell.css"), "utf8");
}
