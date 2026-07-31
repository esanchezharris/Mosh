import path from "node:path";
import { chmod, mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const evidenceDirectory = process.env.MOSH_TASK5_EVIDENCE_DIR;

async function screenshot(page: import("@playwright/test").Page, name: string) {
  if (!evidenceDirectory) return;
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await chmod(evidenceDirectory, 0o700);
  const file = path.join(evidenceDirectory, name);
  await page.screenshot({ path: file, fullPage: true });
  await chmod(file, 0o600);
}

test("owner cockpit stays default-off and renders the no-live-write owner flow", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2,
      template: null,
      values: { theme: "dark" },
      keyOverrides: {},
    }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-composer")).toBeVisible();
  await expect(page.getByTestId("v2-owner-cockpit")).toHaveCount(0);
  await screenshot(page, "ui-default-off.png");

  await page.getByTestId("file-options").click();
  await page.getByTestId("fo-settings").click();
  const ownerSwitch = page.getByRole("switch", { name: "Owner playtest cockpit" });
  await expect(ownerSwitch).toHaveAttribute("aria-checked", "false");
  await ownerSwitch.click();
  await expect(ownerSwitch).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v2-owner-cockpit")).toBeVisible();

  await page.evaluate(() => {
    type JuceHarness = {
      initialisationData: { __juce__functions: string[] };
      postMessage(serialized: string): void;
      backend: { emitByBackend(eventId: string, serialized: string): void };
    };
    const juce = (window as unknown as { __JUCE__: JuceHarness }).__JUCE__;
    juce.initialisationData.__juce__functions = [
      "agent_host_start_playtest",
      "agent_host_close_playtest",
      "agent_host_events",
      "agent_host_create_report",
      "agent_host_approve_report",
      "agent_host_create_repair",
      "agent_host_realtime_secret",
      "agent_host_supervisor_turn",
    ];
    juce.postMessage = (serialized: string) => {
      const message = JSON.parse(serialized) as {
        eventId: string;
        payload: { name: string; params: unknown[]; resultId: number };
      };
      if (message.eventId !== "__juce__invoke") return;
      const request = message.payload.params[0] as Record<string, unknown> | undefined;
      const result = message.payload.name === "agent_host_start_playtest"
        ? { ok: true, active: true, retainTranscript: false, disclosureRequired: true }
        : message.payload.name === "agent_host_events"
          ? { ok: true, events: [] }
          : message.payload.name === "agent_host_create_report"
            ? { ok: true, id: "fixture-report", ...request }
            : message.payload.name === "agent_host_supervisor_turn"
              ? { ok: false, code: "openai_unavailable", error: "OpenAI supervisor unavailable", retryable: true }
              : { ok: true };
      queueMicrotask(() => juce.backend.emitByBackend("__juce__complete", JSON.stringify({
        promiseId: message.payload.resultId,
        result,
      })));
    };
  });

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByTestId("v2-trace-disclosure")).toContainText(
    "Hosted text and tool traces may outlive a locally purged transcript",
  );
  const mic = page.getByTestId("agent-mic");
  await expect(mic).toBeEnabled();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await screenshot(page, "ui-enabled-disclosure-ptt.png");

  const input = page.getByTestId("agent-input");
  await input.fill("bug: metronome drifts after bar four");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("v2-report-inbox")).toContainText("metronome drifts after bar four");
  await screenshot(page, "ui-report-inbox.png");

  await input.fill("rebuild the chorus around my vocal");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("v2-composer").getByText("brain unavailable")).toBeVisible();
  await screenshot(page, "ui-no-key-unavailable.png");

  const exposed = await page.evaluate(() => `${document.body.textContent}\n${window.localStorage.getItem("mosh.settings")}`);
  expect(exposed).not.toMatch(/Bearer\s|127\.0\.0\.1|MOSH_AGENT_HOST_CAPABILITY|OPENAI_API_KEY/);
});
