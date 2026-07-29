// DURABLE worklog-INDEX drift guard.
//
// docs/worklog/INDEX.md is the only map of the dated session notes (CLAUDE.md
// points at it instead of inlining them), so a note that lands without an INDEX
// row is effectively invisible — that is exactly how 2 of 52 notes went missing
// before this guard existed. Asserts, cross-tree (same pattern as
// ui/src/agent/commands.contract.test.ts):
//   (a) every docs/worklog/20*.md note has EXACTLY ONE table row linking it
//       (no orphans, no duplicate rows);
//   (b) every markdown link target in INDEX.md's table resolves to a file on
//       disk (no dead links after a rename);
//   (c) the note count stated in the INDEX header equals the real file count.
//
// Scope: only the `| YYYY-MM-DD | [...](...) |` table rows. The prose header's
// relative links (e.g. ../../CLAUDE.md) are deliberately not covered here.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/docs
const WORKLOG_DIR = resolve(here, "../../../docs/worklog");
const INDEX_PATH = resolve(WORKLOG_DIR, "INDEX.md");

const index = readFileSync(INDEX_PATH, "utf8");

// The dated notes on disk (INDEX.md itself never matches — it doesn't start "20").
const noteFiles = readdirSync(WORKLOG_DIR)
  .filter((f) => /^20\d{2}-\d{2}-\d{2}-.*\.md$/.test(f))
  .sort();

// Table rows only: `| 2026-07-26 | [title](file.md) |`
const tableRows = index
  .split("\n")
  .filter((line) => /^\|\s*20\d{2}-\d{2}-\d{2}\s*\|/.test(line));

const linkTargets: string[] = [];
for (const row of tableRows)
  for (const m of row.matchAll(/\]\(([^)]+)\)/g)) linkTargets.push(m[1]);

describe("docs/worklog/INDEX.md stays in lockstep with the notes on disk", () => {
  it("finds the worklog directory and a non-empty INDEX table (self-check)", () => {
    expect(noteFiles.length, `no 20*.md notes found under ${WORKLOG_DIR}`).toBeGreaterThan(0);
    expect(tableRows.length, "INDEX.md has no `| YYYY-MM-DD | ... |` table rows").toBeGreaterThan(0);
  });

  it("every worklog note has exactly one INDEX row linking it", () => {
    const counts = new Map<string, number>();
    for (const t of linkTargets) counts.set(t, (counts.get(t) ?? 0) + 1);

    const missing = noteFiles.filter((f) => !counts.has(f));
    expect(
      missing,
      `worklog notes with NO row in INDEX.md: ${missing.join(", ")}`,
    ).toEqual([]);

    const duplicated = noteFiles.filter((f) => (counts.get(f) ?? 0) > 1);
    expect(
      duplicated,
      `worklog notes linked MORE THAN ONCE in INDEX.md: ${duplicated
        .map((f) => `${f} (${counts.get(f)} rows)`)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("every link target in the INDEX table resolves to an existing file", () => {
    const broken = linkTargets.filter((t) => !existsSync(resolve(WORKLOG_DIR, t)));
    expect(
      broken,
      `INDEX.md table links whose target file does not exist: ${broken.join(", ")}`,
    ).toEqual([]);
  });

  it("the note count stated in the INDEX header equals the actual file count", () => {
    const m = index.match(/^(\d+) notes,/m);
    expect(m, "INDEX.md header is missing its `<N> notes,` count line").not.toBeNull();
    const stated = Number(m![1]);
    expect(
      stated,
      `INDEX.md header claims ${stated} notes but docs/worklog has ${noteFiles.length} note files`,
    ).toBe(noteFiles.length);
  });
});
