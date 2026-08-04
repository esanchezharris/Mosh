// CAP-EXP-001 — the "no dither" disclosure must not outlive the problem it disclosed.
//
// THE SITUATION THIS EXISTS FOR. Until this change, a 16-bit export truncated, and the
// honest response was to say so: PR #607 adds a note under the bit-depth selector
// ("16-bit renders are truncated — Mosh applies no dither yet…", data-testid
// `export-dither-note`) plus an e2e spec that pins it. That was right *then*. Now that
// the export really does TPDF-dither (src/audio/TpdfDither.h, proven on rendered audio
// by check_export_dither in scripts/verify-hardware/verify.py), the same note is a
// FALSE statement about the product — and a false warning is worse than none, because
// producers act on it: it tells them to avoid a 16-bit master that is now perfectly
// good.
//
// #607 is still OPEN and this branch is cut from main, so there is nothing here to
// delete today. That is exactly why this guard exists rather than a deletion: whichever
// of the two PRs lands second, this test turns "someone must remember to retire the
// disclosure" into a red build. Its whole job is to fail in the future.
//
// If you are here because it went red: DELETE the disclosure paragraph from
// ExportControls.tsx and the "16-bit discloses that there is no dither" test from
// ui/e2e/export-dialog.spec.ts. Do not weaken this file to make it pass.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/ui
const EXPORT_CONTROLS = join(here, "ExportControls.tsx");
const E2E_SPEC = resolve(here, "../../e2e/export-dialog.spec.ts");

const source = readFileSync(EXPORT_CONTROLS, "utf8");

/** Claims that were true before dither shipped and are false after it.
 *
 *  Note there is no exemption for "but I was only QUOTING the old copy in a comment". That
 *  is on purpose and it cost me two rewrites here: an exemption list is how a guard like this
 *  rots, and the phrases are easy to paraphrase. If you need to describe the old state in one
 *  of these two files, describe it — do not quote it. */
const RETIRED_CLAIMS = [
  "export-dither-note",
  "no dither",
  "applies no dither",
  "renders are truncated",
  "without dither",
];

describe("export bit-depth surface", () => {
  // ANCHOR. Without this, every assertion below would also pass on a file that had lost
  // its bit-depth control entirely — a guard whose subject had vanished, reading green.
  it("still offers a reduced bit depth to warn about", () => {
    expect(source).toContain("Bit depth");
    expect(source).toMatch(/depths:\s*\[\s*16\s*,/);
  });

  it("carries no surviving 'there is no dither' disclosure", () => {
    const lower = source.toLowerCase();
    const survivors = RETIRED_CLAIMS.filter((claim) => lower.includes(claim.toLowerCase()));
    expect(
      survivors,
      "ExportControls.tsx still tells producers there is no dither, but CAP-EXP-001 " +
        "shipped TPDF dither for every export below 32-bit. Delete the note.",
    ).toEqual([]);
  });

  it("has no e2e spec pinning the retired disclosure", () => {
    if (!existsSync(E2E_SPEC)) return; // spec file is optional from this test's point of view
    const spec = readFileSync(E2E_SPEC, "utf8").toLowerCase();
    const survivors = RETIRED_CLAIMS.filter((claim) => spec.includes(claim.toLowerCase()));
    expect(
      survivors,
      "ui/e2e/export-dialog.spec.ts still asserts the 'no dither' disclosure. That spec " +
        "is what would keep the stale note alive; delete the assertion deliberately.",
    ).toEqual([]);
  });
});
