import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "shell.css"), "utf8");

describe("v2 shell.css .v2-btn disabled affordance", () => {
  it("ships a .v2-btn:disabled rule so disabled buttons read as non-interactive", () => {
    // .v2-btn renders disabled at real sites (LyricPanel/RhymeTool). Without this
    // rule a disabled button stayed full-opacity with a pointer cursor.
    expect(css).toContain(".v2-btn:disabled");
  });

  it("guards the hover-lift and active-scale with :not(:disabled)", () => {
    // A disabled button must not lift on hover or scale on press (it reads clickable).
    expect(css).toContain(".v2-btn:hover:not(:disabled)");
    expect(css).toContain(".v2-btn:active:not(:disabled)");
  });
});
