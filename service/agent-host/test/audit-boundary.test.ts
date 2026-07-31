import { describe, expect, it } from "vitest";
import { sanitizeAuditData } from "../src/audit-boundary.js";

describe("audit durability boundary", () => {
  it("redacts configured and generic provider credentials", () => {
    const safe = sanitizeAuditData({
      configured: "prefix configured-secret-value suffix",
      bearer: "Bearer bearer-token-value",
      openai: "sk-openai-token-value",
      github: "github_pat_githubtokenvalue",
      supabase: "eyJheader123456789.payload123456789.signature123456789",
      assignment: "SUPABASE_SERVICE_ROLE_KEY=service-role-value",
    }, { CUSTOM_SECRET: "configured-secret-value" });
    const serialized = JSON.stringify(safe);

    expect(serialized).not.toMatch(
      /configured-secret-value|bearer-token-value|openai-token-value|githubtokenvalue|service-role-value|eyJheader/u,
    );
    expect(serialized).toContain("[REDACTED]");
  });

  it("caps depth, arrays, strings, and total event size", () => {
    const safe = sanitizeAuditData({
      oversized: "x".repeat(100_000),
      array: Array.from({ length: 100 }, (_, index) => index),
      deep: { one: { two: { three: { four: { five: "secret" } } } } },
    }, {});

    expect(Buffer.byteLength(JSON.stringify(safe), "utf8")).toBeLessThanOrEqual(16_384);
    expect(safe.oversized).toBe("x".repeat(1_024));
    expect(safe.array).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(JSON.stringify(safe)).toContain("[TRUNCATED]");
  });
});
