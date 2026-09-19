import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test as setup } from "@playwright/test";

// Playwright setup project (see ui/playwright.config.ts's "phonepad-build" project):
// builds the single-file pad bundle to ui/phonepad-dist/index.html before the
// "phonepad" project's specs serve it from an ephemeral loopback static server.
const uiDir = fileURLToPath(new URL("../../../", import.meta.url));

setup("build the phonepad bundle", () => {
  execFileSync("npm", ["run", "build:phonepad"], { cwd: uiDir, stdio: "inherit" });
});
