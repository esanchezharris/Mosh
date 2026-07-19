import { describe, it, expect } from "vitest";
import { formatPeerError } from "./peerErrors";
import type { PeerInfo } from "./sync";

// #40 — lock-denied errors surface the raw peer UUID; the display layer maps any
// known peer id to its display name. Unknown ids pass through untouched.

const peers: Record<string, PeerInfo> = {
  "550e8400-e29b-41d4-a716-446655440000": { name: "Bo", color: "#e0457b", online: true },
  "peer-b": { name: "Ada", color: "#3aa0ff", online: false },
};

describe("formatPeerError (#40)", () => {
  it("maps a known peer UUID to the display name", () => {
    expect(formatPeerError("blocked: locked by 550e8400-e29b-41d4-a716-446655440000", peers))
      .toBe("blocked: locked by Bo");
  });

  it("maps every occurrence and multiple ids", () => {
    expect(formatPeerError("locked by peer-b; retry after peer-b or 550e8400-e29b-41d4-a716-446655440000", peers))
      .toBe("locked by Ada; retry after Ada or Bo");
  });

  it("leaves unknown ids untouched", () => {
    const msg = "blocked: locked by 99999999-aaaa-bbbb-cccc-000000000000";
    expect(formatPeerError(msg, peers)).toBe(msg);
  });

  it("no peers → identity", () => {
    expect(formatPeerError("locked by peer-b", {})).toBe("locked by peer-b");
  });

  it("ignores peers with empty names rather than erasing the id", () => {
    const withBlank: Record<string, PeerInfo> = { "peer-x": { name: "", color: "#fff", online: true } };
    expect(formatPeerError("locked by peer-x", withBlank)).toBe("locked by peer-x");
  });

  it("matches whole tokens only — short mock ids must not corrupt words", () => {
    const mockPeers: Record<string, PeerInfo> = {
      me: { name: "You", color: "#fff", online: true },
      bo: { name: "Bo", color: "#e0457b", online: true },
    };
    // "volume"/"bounce" contain the ids "me"/"bo" as substrings
    expect(formatPeerError("bounce failed while setting volume", mockPeers))
      .toBe("bounce failed while setting volume");
    expect(formatPeerError("blocked: locked by bo", mockPeers)).toBe("blocked: locked by Bo");
    expect(formatPeerError("locked by me", mockPeers)).toBe("locked by You");
  });

  it("ids with regex metacharacters are treated literally", () => {
    const weird: Record<string, PeerInfo> = { "p+1(x)": { name: "Plus", color: "#fff", online: true } };
    expect(formatPeerError("locked by p+1(x)", weird)).toBe("locked by Plus");
  });
});
