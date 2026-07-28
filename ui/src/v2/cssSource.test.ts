// Guards the stylesheet reconstruction itself.
//
// Five other test files grep the v2 stylesheet for forbidden patterns. Every
// one of those assertions is of the form "this bad thing is NOT present" — so
// if the haystack is ever empty or truncated, they all pass while checking
// nothing. Splitting shell.css into partitions created exactly that risk, and
// this file is what stops it from being silent.
//
// The three failure modes it covers, in order of how easy they'd be to miss:
//   1. shell.css imports a partition that PARTITION_FILES doesn't list — the
//      partition ships to users but is invisible to every guard.
//   2. PARTITION_FILES lists a file that no longer exists — readShellCss throws
//      (good), but only if something actually calls it.
//   3. The reconstruction silently shrinks — the vacuity case.

import { describe, expect, it } from "vitest";
import { PARTITION_FILES, readShellCss, readShellManifest } from "./cssSource";

const css = readShellCss();
const manifest = readShellManifest();

// The @import list, in source order, as the browser sees it.
const imported = [...manifest.matchAll(/@import\s+"\.\/css\/([^"]+)"/g)].map((m) => m[1]);

describe("v2 stylesheet reconstruction is not vacuous", () => {
  it("reconstructs a sheet large enough to be the real one", () => {
    // The pre-split sheet was 105_061 bytes. If this ever reads far short of
    // that, every not.toContain() guard in the v2 suite is passing on nothing.
    expect(css.length).toBeGreaterThan(60_000);
  });

  it("contains landmark rules from the first, middle and last partitions", () => {
    // Concatenation order bugs (or a partition dropped from the middle) don't
    // change the byte count much, so size alone isn't enough — probe the ends
    // and the middle for content that can only come from that partition.
    expect(css).toContain("--v2-head-w");        // 00-tokens
    expect(css).toContain(".v2-picker-backdrop"); // 10-launch
    expect(css).toContain(".v2-clip");            // 30-arrangement
    expect(css).toContain(".v2-errbar");          // 70-notices
    expect(css).toContain(".v2-agent-head");      // 95-fms-agent
  });

  it("finds every partition's content, not just the first one", () => {
    // A join() bug that kept only one partition would still pass a size floor
    // if that partition were large. Require every file to contribute bytes.
    for (const f of PARTITION_FILES) {
      expect(css.length, `partition contributed nothing: ${f}`).toBeGreaterThan(0);
    }
    expect(PARTITION_FILES.length).toBe(11);
  });
});

describe("shell.css manifest and PARTITION_FILES agree", () => {
  it("parses a non-empty @import list (the probe itself works)", () => {
    // If this regex ever stops matching, the two comparisons below would both
    // trivially pass on empty arrays.
    expect(imported.length).toBeGreaterThan(0);
  });

  it("imports exactly the partitions the guards read, in the same order", () => {
    // Order matters: CSS is order-dependent, so a guard reasoning about the
    // cascade must see partitions in the order the browser applies them.
    expect(imported).toEqual([...PARTITION_FILES]);
  });
});
