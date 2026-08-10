import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = (file: string): string => readFileSync(resolve(process.cwd(), "src/protools/css", file), "utf8");
const tokens = css("tokens.css");
const shell = css("shell.css");
const toolbar = css("toolbar.css");
const panels = css("panels.css");
const responsive = css("responsive.css");
const timeline = css("timeline.css");

function tokenValue(source: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, "i").exec(source);
  if (!match?.[1]) throw new Error(`Missing ${name} token`);
  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/../g);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color ${hex}`);
  const [red, green, blue] = channels.map((channel) => {
    const normalized = Number.parseInt(channel, 16) / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Pro Tools accessibility tokens", () => {
  it("keeps selected, danger, and pre-roll small text at AA contrast", () => {
    const [dark, classic] = tokens.split(".protools-shell[data-pt-theme=\"classic\"]");
    if (!dark || !classic) throw new Error("theme token scopes are missing");

    for (const scope of [dark, classic]) {
      expect(contrastRatio(tokenValue(scope, "--pt-selected"), tokenValue(scope, "--pt-on-selected"))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokenValue(scope, "--pt-danger"), tokenValue(scope, "--pt-on-danger"))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokenValue(scope, "--pt-preroll"), tokenValue(scope, "--pt-on-preroll"))).toBeGreaterThanOrEqual(4.5);
    }
    expect(toolbar).toContain("color: var(--pt-on-selected);");
    expect(panels).toContain("color: var(--pt-on-danger);");
    expect(timeline).toContain("color: var(--pt-on-preroll);");
  });

  it("keeps the Classic focus ring above non-text contrast on every shell surface", () => {
    const classic = tokens.split(".protools-shell[data-pt-theme=\"classic\"]")[1];
    if (!classic) throw new Error("Classic token scope is missing");
    const ring = tokenValue(classic, "--pt-focus-ring");
    for (const surface of ["--pt-canvas", "--pt-surface", "--pt-raised", "--pt-inset"]) {
      expect(contrastRatio(ring, tokenValue(classic, surface))).toBeGreaterThanOrEqual(3);
    }
    expect(shell).toContain("outline: 2px solid var(--pt-focus-ring);");
  });

  it("keeps 10px ruler labels at AA contrast over the raised ruler row", () => {
    const [dark, classic] = tokens.split(".protools-shell[data-pt-theme=\"classic\"]");
    if (!dark || !classic) throw new Error("theme token scopes are missing");

    for (const scope of [dark, classic]) {
      expect(contrastRatio(tokenValue(scope, "--pt-text-muted"), tokenValue(scope, "--pt-raised"))).toBeGreaterThanOrEqual(4.5);
    }
    expect(timeline).toContain("color: var(--pt-text-muted);");
    expect(timeline).toContain("background: var(--pt-raised);");
    expect(timeline).toContain("font: 500 10px/1.2 ui-monospace");
  });

  it("keeps compact toolbar groups reachable by horizontal scrolling", () => {
    expect(toolbar).toContain("overflow-x: auto;");
    expect(toolbar).toContain(".pt-zoom-presets button {");
    expect(toolbar).toContain("min-height: 24px;");
    expect(toolbar).toContain(".pt-zoom-media button {");
    expect(responsive).toContain(".pt-toolbar-group { flex: 0 0 auto; }");
    expect(responsive).not.toContain(".pt-grid-group { display: none; }");
    expect(responsive).not.toContain(".pt-view-group { display: none; }");
  });
});
