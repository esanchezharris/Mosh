import { describe, expect, it, vi } from "vitest";
import { AgentHostApiError, AgentHostClient, type HostEvent } from "./agentHostClient";

describe("owner cockpit Agent Host client", () => {
  it("recovers only validated durable reports from the native start envelope", async () => {
    const client = new AgentHostClient({
      start: vi.fn(async () => ({
        ok: true,
        active: true,
        retainTranscript: false,
        disclosureRequired: false,
        reports: [{
          version: 1,
          id: "report-1",
          playtestId: "private-playtest-id",
          kind: "blocker",
          title: "Playback is silent",
          body: "The transport moves but no audio is heard.",
          status: "approved",
          evidence: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:01:00.000Z",
        }],
      })),
      close: vi.fn(),
      events: vi.fn(),
      secret: vi.fn(),
      createReport: vi.fn(),
      approveReport: vi.fn(),
    });

    expect(await client.start(false)).toEqual({
      active: true,
      retainTranscript: false,
      disclosureRequired: false,
      reports: [{
        id: "report-1",
        kind: "blocker",
        title: "Playback is silent",
        body: "The transport moves but no audio is heard.",
        status: "approved",
      }],
    });
  });

  it("starts and closes an explicit playtest without browser host credentials", async () => {
    const bridge = {
      start: vi.fn(async () => ({ ok: true, active: true, retainTranscript: false, disclosureRequired: true, reports: [] })),
      close: vi.fn(async () => ({ ok: true, active: false, retainTranscript: true })),
      events: vi.fn(),
      secret: vi.fn(),
      createReport: vi.fn(),
      approveReport: vi.fn(),
    };
    const client = new AgentHostClient(bridge);
    const started = await client.start(false);
    const closed = await client.close(true);
    expect(started).toEqual({ active: true, retainTranscript: false, disclosureRequired: true, reports: [] });
    expect(closed).toEqual({ active: false, retainTranscript: true });
    expect(JSON.stringify([started, closed])).not.toMatch(/bearer|capability|127\\.0\\.0\\.1|https?:/i);
  });

  it("surfaces typed host errors", async () => {
    const client = new AgentHostClient({
      start: vi.fn(async () => ({ ok: false, code: "host_unavailable", error: "Host unavailable", retryable: true })),
      close: vi.fn(),
      events: vi.fn(),
      secret: vi.fn(),
      createReport: vi.fn(),
      approveReport: vi.fn(),
    });
    await expect(client.start(false)).rejects.toMatchObject({
      name: "AgentHostApiError",
      code: "host_unavailable",
      retryable: true,
    });
  });

  it("rejects malformed native error envelopes instead of asserting their types", async () => {
    const client = new AgentHostClient({
      start: vi.fn(async () => ({ ok: false, code: [], error: 7, retryable: "yes" })),
      close: vi.fn(),
      events: vi.fn(),
      secret: vi.fn(),
      createReport: vi.fn(),
      approveReport: vi.fn(),
    });

    await expect(client.start(false)).rejects.toMatchObject({
      name: "AgentHostApiError",
      code: "invalid_response",
      retryable: false,
    });
  });

  it("reconnects event delivery from the last sequence without duplicating events", async () => {
    vi.useFakeTimers();
    const events = vi.fn()
      .mockRejectedValueOnce(new AgentHostApiError("temporary", "host_unavailable", true))
      .mockResolvedValueOnce({ ok: true, events: [{ sequence: 1, type: "playtest.created", data: {} }] })
      .mockResolvedValueOnce({ ok: true, events: [{ sequence: 1, type: "playtest.created", data: {} }, { sequence: 2, type: "report.created", data: { reportId: "r1" } }] });
    const client = new AgentHostClient({
      start: vi.fn(),
      close: vi.fn(),
      events,
      secret: vi.fn(),
      createReport: vi.fn(),
      approveReport: vi.fn(),
    }, 100);
    const seen: number[] = [];
    const stop = client.watchEvents((event) => {
      seen.push(event.sequence);
      if (event.sequence === 2) stop();
    });

    await vi.advanceTimersByTimeAsync(400);

    expect(seen).toEqual([1, 2]);
    expect(events.mock.calls.map((call) => call[0])).toEqual([0, 0, 1]);
    vi.useRealTimers();
  });

  it("drops malformed event payloads at the native boundary", async () => {
    vi.useFakeTimers();
    const events = vi.fn().mockResolvedValue({
      ok: true,
      events: [
        { sequence: 1, type: 42, data: [] },
        { sequence: 2, type: "report.created", data: { reportId: "r2" } },
      ],
    });
    const client = new AgentHostClient({
      start: vi.fn(),
      close: vi.fn(),
      events,
      secret: vi.fn(),
      createReport: vi.fn(),
      approveReport: vi.fn(),
    }, 100);
    const seen: HostEvent[] = [];
    const stop = client.watchEvents((event) => {
      seen.push(event);
      stop();
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(seen).toEqual([
      { sequence: 2, type: "report.created", data: { reportId: "r2" } },
    ]);
    vi.useRealTimers();
  });
});
