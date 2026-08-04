import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Guards the agent-facing doc surface against dead local links.
//
// This exists because of a real, shipped rot. `docs/worklog/` was pruned in the
// public-cleanup pass (1d2bb1e9) while CLAUDE.md — auto-loaded into EVERY agent
// session — still told agents to grep it before starting work and write a note into
// it when finishing. ARCHITECTURE.md still advertised `INDEX.md` as "the doc map —
// start here" and `CURRENT_STATUS.md` as "the one rolling status doc"; both were
// gone. Six RFC links pointed into the removed directory. A later pass (de36a454)
// fixed dead links elsewhere and missed all of it.
//
// The reason it went unnoticed for that long is that the vitest guard which used to
// enforce the doc index — `ui/src/docs/worklogIndex.test.ts` — was itself deleted
// along with the journals it protected, and nothing replaced it. This is that
// replacement, scoped to the class of breakage that actually bit rather than to one
// index file.
//
// Scope: the docs an agent is pointed at — the three entry docs plus `docs/`.
// `docs/archive/` is deliberately excluded: ARCHITECTURE.md declares it "dated
// point-in-time reports, frozen by design; kept for history", so its links are
// allowed to reference a tree that has since moved on.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const ENTRY_DOCS = ["CLAUDE.md", "ARCHITECTURE.md", "README.md"];
const EXCLUDED_DIRS = new Set(["archive"]);

/** Markdown inline links: [text](target). */
const LINK = /\[[^\]]*\]\(([^)]+)\)/g;

function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry)) walkMarkdown(abs, out);
    } else if (entry.endsWith(".md")) {
      out.push(abs);
    }
  }
  return out;
}

function scannedFiles(): string[] {
  const files = ENTRY_DOCS.map((f) => join(repoRoot, f)).filter((f) => existsSync(f));
  return [...files, ...walkMarkdown(join(repoRoot, "docs"))];
}

/**
 * Reduce a raw link target to a path to test, or null when it is not a local file
 * reference at all. Handles the two conventions this repo actually writes:
 * a trailing `:42` / `:42-50` line cite, and `#anchor` / `?query` suffixes.
 */
function toLocalPath(target: string): string | null {
  const raw = target.trim();
  if (!raw || /^(https?:|mailto:|tel:|#)/i.test(raw)) return null;
  // `[...](const juce::var& msg)` — a code signature in link syntax, not a link.
  if (/\s/.test(raw)) return null;
  const path = raw.split("#")[0].split("?")[0].replace(/:\d+(-\d+)?$/, "");
  return path || null;
}

/**
 * A link resolves if it works doc-relative OR repo-root-relative. Both are in use:
 * `docs/rfc/README.md` writes `[TEMPLATE.md](TEMPLATE.md)` (doc-relative), while
 * `docs/MULTIPLAYER.md` writes `[…](src/multiplayer/LockManager.cpp:13)`
 * (repo-root-relative, the clickable convention the harness renders).
 */
function resolves(mdFile: string, path: string): boolean {
  return (
    existsSync(resolve(dirname(mdFile), path)) || existsSync(resolve(repoRoot, path))
  );
}

interface DeadLink {
  file: string;
  line: number;
  target: string;
}

function findDeadLinks(): { dead: DeadLink[]; files: number; links: number } {
  const dead: DeadLink[] = [];
  const files = scannedFiles();
  let links = 0;

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      for (const match of text.matchAll(LINK)) {
        const path = toLocalPath(match[1]);
        if (path === null) continue;
        links++;
        if (!resolves(file, path)) {
          dead.push({
            file: file.slice(repoRoot.length + 1),
            line: i + 1,
            target: path,
          });
        }
      }
    });
  }
  return { dead, files: files.length, links };
}

describe("doc links", () => {
  const { dead, files, links } = findDeadLinks();

  // A scanner that silently matches nothing looks exactly like a passing guard —
  // this repo's recorded failure mode. Measured at the time of writing: 162 markdown
  // files, 240 inline links, 196 of them local paths worth resolving. The floors sit
  // under those so ordinary doc churn does not trip them, but a broken walk, a broken
  // regex, or a moved repo root fails loudly instead of going green.
  it("actually scans the doc surface", () => {
    expect(files).toBeGreaterThan(120);
    expect(links).toBeGreaterThan(150);
  });

  it("has no dead local links in CLAUDE.md, ARCHITECTURE.md, README.md or docs/", () => {
    const report = dead.map((d) => `  ${d.file}:${d.line} -> ${d.target}`).join("\n");
    expect(dead, `dead local doc links:\n${report}`).toEqual([]);
  });
});
