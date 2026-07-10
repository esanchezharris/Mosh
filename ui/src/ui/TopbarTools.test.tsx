import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrainingTool } from "./TopbarTools";
import { useStore } from "../store";
import type { CommandResult, TrainingState } from "../types";

vi.mock("../bridge", async () => {
  const actual = await vi.importActual<typeof import("../bridge")>("../bridge");
  return {
    ...actual,
    pickFiles: vi.fn(async () => ({ ok: true, files: ["/mock/source.wav"] })),
  };
});

const training: TrainingState = {
  registryPath: "/mock",
  statePath: "/mock/state.json",
  activeAdapterId: "",
  activeAdapterPath: "",
  activeCorpusHash: "",
  sources: [],
  adapters: [],
  jobs: [],
};

function setFieldValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("TrainingTool provenance helper", () => {
  let host: HTMLDivElement;
  let root: Root;
  const execCalls: { command: string; args?: Record<string, unknown> }[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    execCalls.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    useStore.setState({
      exec: vi.fn(async (command: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        execCalls.push({ command, args });
        return { ok: true, command };
      }),
      refresh: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("copies the backwards interview into source notes and submits them", () => {
    act(() => {
      root.render(React.createElement(TrainingTool, { training }));
    });

    const opener = host.querySelector<HTMLButtonElement>('button[title="Type-beat training"]');
    expect(opener).not.toBeNull();
    act(() => {
      opener!.click();
    });

    const inputs = document.body.querySelectorAll<HTMLInputElement>("input");
    const textareas = document.body.querySelectorAll<HTMLTextAreaElement>("textarea");
    expect(inputs.length).toBeGreaterThan(0);
    expect(textareas.length).toBeGreaterThan(0);

    act(() => {
      setFieldValue(textareas[0], "tight groove");
    });

    const useNotes = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Use notes");
    expect(useNotes).toBeTruthy();
    act(() => {
      useNotes!.click();
    });

    const sourceNotes = [...document.body.querySelectorAll<HTMLTextAreaElement>("textarea")].find((t) => t.placeholder?.includes("tutorials, samples, credits"));
    expect(sourceNotes).toBeTruthy();
    expect(sourceNotes!.value).toContain("What sound are we working backward from?");

    const values = [
      ["Beat title", "Reference beat"],
      ["Creator", "Producer"],
      ["Source URL", "https://example.com"],
      ["Audio file", "/mock/source.wav"],
      ["License claim", "I may use this"],
      ["Rights proof", "link + note"],
    ] as const;
    for (const [label, value] of values) {
      const input = [...document.body.querySelectorAll<HTMLInputElement>("input")].find((el) => el.previousElementSibling?.textContent === label);
      expect(input).toBeTruthy();
      act(() => {
        setFieldValue(input!, value);
      });
    }

    const add = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add source");
    expect(add).toBeTruthy();
    act(() => {
      add!.click();
    });

    const call = execCalls.find((c) => c.command === "import_training_source");
    expect(call).toBeTruthy();
    expect(String(call!.args?.notes ?? "")).toContain("tight groove");
    expect(String(call!.args?.notes ?? "")).toContain("What sound are we working backward from?");
  });
});
