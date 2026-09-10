import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("./juce/index.js", () => ({ getNativeFunction: () => invoke }));
import { brainChat } from "./bridge";

beforeEach(() => {
  vi.stubGlobal("__JUCE__", { initialisationData: { __juce__functions: ["brain_chat"] } });
  invoke.mockReset();
});

it("retains the native receipt without changing the request", async () => {
  const receipt = { provider: "openai", model: "configured-alias", responseModel: "reported-version",
    usage: { prompt_tokens: 12, completion_tokens: 8 }, rawResponse: '{"synthetic":true}', statusCode: 200, ms: 7 };
  invoke.mockResolvedValue({ ok: true, content: "{}", ...receipt });
  const messages = [{ role: "user", content: "synthetic preflight" }];
  expect(await brainChat(messages, "openai")).toEqual({ content: "{}", ...receipt });
  expect(invoke).toHaveBeenCalledWith({ messages, provider: "openai" });
});

it("retains an HTTP failure receipt on the thrown error", async () => {
  const receipt = { provider: "openai", model: "alias", rawResponse: '{"error":"quota"}', statusCode: 429, ms: 2 };
  invoke.mockResolvedValue({ ok: false, error: "quota", ...receipt });
  await expect(brainChat([])).rejects.toMatchObject({ message: "quota", receipt });
});

it("does not invent missing usage or reported model", async () => {
  invoke.mockResolvedValue({ ok: true, content: "{}", provider: "proxy" });
  expect(await brainChat([])).toEqual({ content: "{}", provider: "proxy" });
});

it("rejects malformed native replies", async () => {
  invoke.mockResolvedValue({ ok: true, content: 17 });
  await expect(brainChat([])).rejects.toThrow("malformed brain response");
});
