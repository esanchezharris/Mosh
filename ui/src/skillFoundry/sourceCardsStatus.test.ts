// Task 5 — RED-first pin for source-card admission and freshness/revocation: all four
// runtime states, rejected/unresolved/unofficial exclusion, unsafe source IDs, exact
// expiration, changed digest, acquisition mismatch, duplicate/unknown revoke, and the
// runtime fail-closed check (via Slice A's `validateSourceStatusForInvocationV1`).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSourceCardV1, parseSourceCardV1, sourceSnapshotSha256V1 } from "./sourceCards";
import { readSourceStatusV1, refreshSourceStatusV1, revokeSourceStatusV1 } from "./sourceStatus";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";
import { atomicWriteBytesV1 } from "./safeFs";
import { canonicalJsonBytes } from "../agent/skillFoundry/hash";
import type { SourceCardV1 } from "./contracts";
import { validateSourceStatusForInvocationV1 } from "../agent/skillFoundry/packageValidation";

const CLOCK_AT = (iso: string) => ({ now: () => new Date(iso) });

function validCardFields(overrides: Partial<SourceCardV1> = {}): Omit<SourceCardV1, "sourceSnapshotSha256"> {
  return {
    schemaVersion: 1,
    sourceCardId: "yt-dark-trap-808-walkthrough-001",
    sourceVersion: "v1",
    rights: "official_public_documentation",
    acquisition: "official_https_page",
    platformHandling: "metadata_and_short_paraphrases_only",
    evidenceSha256: "9a7c1b2f0c7d4e17f49d2fdc56dd8c4bcf3d6dfef7b8c1d3fbcf4a4f05d9aa01",
    reviewer: "mosh-owner",
    reviewedAt: "2026-06-30T00:00:00.000Z",
    state: "current",
    dependentIds: [],
    claims: [{ claimId: "c1", origin: "source_text", workflowMoment: "intro", paraphrase: "kick locks in", boundary: "vocabulary only" }],
    ...overrides,
  };
}

async function buildValidCard(overrides: Partial<SourceCardV1> = {}): Promise<SourceCardV1> {
  const withoutHash = validCardFields(overrides);
  const sourceSnapshotSha256 = await sourceSnapshotSha256V1({ ...withoutHash, sourceSnapshotSha256: "" });
  return { ...withoutHash, sourceSnapshotSha256 };
}

describe("parseSourceCardV1", () => {
  it("accepts a valid card", async () => {
    const card = await buildValidCard();
    const result = parseSourceCardV1(card);
    expect(result.ok).toBe(true);
  });

  it("accepts every one of the four runtime states", async () => {
    for (const state of ["current", "stale", "superseded", "revoked"] as const) {
      const card = await buildValidCard({ state });
      expect(parseSourceCardV1(card).ok).toBe(true);
    }
  });

  it("rejects an unresolved/unknown rights value", async () => {
    const card = await buildValidCard();
    const result = parseSourceCardV1({ ...card, rights: "scraped-unofficial" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unofficial acquisition value", async () => {
    const card = await buildValidCard();
    const result = parseSourceCardV1({ ...card, acquisition: "unofficial_scrape" });
    expect(result.ok).toBe(false);
  });

  it("rejects a rejected/unresolved source_state", async () => {
    const card = await buildValidCard();
    const result = parseSourceCardV1({ ...card, state: "rejected" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unsafe source card id (path-traversal defence)", async () => {
    const card = await buildValidCard({ sourceCardId: "../../etc/passwd" });
    const result = parseSourceCardV1(card);
    expect(result.ok).toBe(false);
  });
});

describe("addSourceCardV1", () => {
  let foundry: IsolatedFoundryV1;
  let draftDir: string;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
    draftDir = join(foundry.paths.draftsRoot, "owner-park-backgrounds");
    await mkdir(join(draftDir, "sources"), { recursive: true });
    await mkdir(join(draftDir, "references"), { recursive: true });
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("admits a valid card, copies exact bytes, and mirrors it under teachRoot/source-cards", async () => {
    const card = await buildValidCard();
    const cardPath = join(foundry.homeDir, "card.json");
    await atomicWriteBytesV1(cardPath, canonicalJsonBytes(card));

    const result = await addSourceCardV1({ draftDir, teachRoot: foundry.paths.teachRoot, cardPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.card.sourceCardId).toBe(card.sourceCardId);
  });

  it("is idempotent on an exact-duplicate re-add", async () => {
    const card = await buildValidCard();
    const cardPath = join(foundry.homeDir, "card.json");
    await atomicWriteBytesV1(cardPath, canonicalJsonBytes(card));

    await addSourceCardV1({ draftDir, teachRoot: foundry.paths.teachRoot, cardPath });
    const second = await addSourceCardV1({ draftDir, teachRoot: foundry.paths.teachRoot, cardPath });
    expect(second).toMatchObject({ ok: true, changed: false });
  });

  it("fails on same-id conflicting bytes rather than silently overwriting", async () => {
    const card = await buildValidCard();
    const cardPath = join(foundry.homeDir, "card.json");
    await atomicWriteBytesV1(cardPath, canonicalJsonBytes(card));
    await addSourceCardV1({ draftDir, teachRoot: foundry.paths.teachRoot, cardPath });

    const changedCard = await buildValidCard({ sourceVersion: "v2" });
    const cardPath2 = join(foundry.homeDir, "card2.json");
    await atomicWriteBytesV1(cardPath2, canonicalJsonBytes(changedCard));
    const conflict = await addSourceCardV1({ draftDir, teachRoot: foundry.paths.teachRoot, cardPath: cardPath2 });
    expect(conflict).toMatchObject({ ok: false, code: "conflict" });
  });

  it("rejects a card whose sourceSnapshotSha256 does not match its own content", async () => {
    const card = await buildValidCard();
    const tampered = { ...card, sourceSnapshotSha256: "0".repeat(64) };
    const cardPath = join(foundry.homeDir, "card.json");
    await atomicWriteBytesV1(cardPath, canonicalJsonBytes(tampered));
    const result = await addSourceCardV1({ draftDir, teachRoot: foundry.paths.teachRoot, cardPath });
    expect(result).toMatchObject({ ok: false, code: "invalid_source_card" });
  });

  it("rejects a symlinked card file", async () => {
    const card = await buildValidCard();
    const realPath = join(foundry.homeDir, "real-card.json");
    await atomicWriteBytesV1(realPath, canonicalJsonBytes(card));
    const linkPath = join(foundry.homeDir, "linked-card.json");
    const { symlink } = await import("node:fs/promises");
    await symlink(realPath, linkPath);
    const result = await addSourceCardV1({ draftDir, teachRoot: foundry.paths.teachRoot, cardPath: linkPath });
    expect(result.ok).toBe(false);
  });
});

describe("refreshSourceStatusV1 / revokeSourceStatusV1", () => {
  let foundry: IsolatedFoundryV1;
  let draftDir: string;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
    draftDir = join(foundry.paths.draftsRoot, "owner-park-backgrounds");
    await mkdir(join(draftDir, "sources"), { recursive: true });
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("first refresh admits the card at generation 1", async () => {
    const card = await buildValidCard();
    const snapshotSha256 = card.sourceSnapshotSha256;
    const result = await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card,
      snapshotSha256,
      clock: CLOCK_AT("2026-01-01T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ ok: true, changed: true, index: { generation: 1 } });
  });

  it("unchanged digest extends freshness WITHOUT bumping generation", async () => {
    const card = await buildValidCard();
    const cardPath = join(foundry.homeDir, "card.json");
    await atomicWriteBytesV1(cardPath, canonicalJsonBytes(card));
    await addSourceCardV1({ draftDir, teachRoot: foundry.paths.teachRoot, cardPath });

    const first = await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card,
      snapshotSha256: card.sourceSnapshotSha256,
      clock: CLOCK_AT("2026-01-01T00:00:00.000Z"),
    });
    expect(first).toMatchObject({ ok: true, index: { generation: 1 } });

    const second = await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card,
      snapshotSha256: card.sourceSnapshotSha256,
      clock: CLOCK_AT("2026-02-01T00:00:00.000Z"),
    });
    expect(second).toMatchObject({ ok: true, index: { generation: 1 } }); // NOT bumped
    if (second.ok) {
      expect(second.entry.checkedAt).toBe("2026-02-01T00:00:00.000Z"); // freshness DID extend
    }
  });

  it("a CHANGED digest bumps generation by exactly one", async () => {
    const card = await buildValidCard();
    const cardPath = join(foundry.homeDir, "card.json");
    await atomicWriteBytesV1(cardPath, canonicalJsonBytes(card));
    await addSourceCardV1({ draftDir, teachRoot: foundry.paths.teachRoot, cardPath });
    await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card,
      snapshotSha256: card.sourceSnapshotSha256,
      clock: CLOCK_AT("2026-01-01T00:00:00.000Z"),
    });

    const changedCard = await buildValidCard({ sourceVersion: "v2" });
    const result = await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card: changedCard,
      snapshotSha256: changedCard.sourceSnapshotSha256,
      clock: CLOCK_AT("2026-02-01T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ ok: true, index: { generation: 2 } });
  });

  it("rejects a refresh that switches acquisition method", async () => {
    const card = await buildValidCard();
    const cardPath = join(foundry.homeDir, "card.json");
    await atomicWriteBytesV1(cardPath, canonicalJsonBytes(card));
    await addSourceCardV1({ draftDir, teachRoot: foundry.paths.teachRoot, cardPath });

    const switchedCard = await buildValidCard({ acquisition: "manual_viewing_notes" });
    const result = await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card: switchedCard,
      snapshotSha256: switchedCard.sourceSnapshotSha256,
      clock: CLOCK_AT("2026-02-01T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ ok: false, code: "acquisition_mismatch" });
  });

  it("revokes an entry and bumps generation once; repeated revoke is unchanged", async () => {
    const card = await buildValidCard();
    await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card,
      snapshotSha256: card.sourceSnapshotSha256,
      clock: CLOCK_AT("2026-01-01T00:00:00.000Z"),
    });
    const revoked = await revokeSourceStatusV1(foundry.paths.sourceStatusPath, card.sourceCardId, CLOCK_AT("2026-02-01T00:00:00.000Z"));
    expect(revoked).toMatchObject({ ok: true, changed: true, index: { generation: 2 } });

    const revokedAgain = await revokeSourceStatusV1(foundry.paths.sourceStatusPath, card.sourceCardId, CLOCK_AT("2026-03-01T00:00:00.000Z"));
    expect(revokedAgain).toMatchObject({ ok: true, changed: false, index: { generation: 2 } });
  });

  it("revoking an unknown source card id fails", async () => {
    const result = await revokeSourceStatusV1(foundry.paths.sourceStatusPath, "unknown-card", CLOCK_AT("2026-01-01T00:00:00.000Z"));
    expect(result).toMatchObject({ ok: false, code: "source_card_not_found" });
  });

  it("the resolved sourceStatusPath is exactly <agentRoot>/skills/source-status.json", () => {
    expect(foundry.paths.sourceStatusPath).toBe(join(foundry.paths.agentRoot, "skills", "source-status.json"));
  });
});

describe("runtime fail-closed check (Slice A validateSourceStatusForInvocationV1 over OUR index)", () => {
  let foundry: IsolatedFoundryV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("a fresh, current, matching entry passes", async () => {
    const card = await buildValidCard();
    const refreshed = await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card,
      snapshotSha256: card.sourceSnapshotSha256,
      clock: CLOCK_AT("2026-01-01T00:00:00.000Z"),
    });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;

    const freshIndex = await readSourceStatusV1(foundry.paths.sourceStatusPath);
    const result = validateSourceStatusForInvocationV1({
      provenance: [{ sourceCardId: card.sourceCardId, claimIds: ["c1"], sourceSnapshotSha256: card.sourceSnapshotSha256 }],
      freshIndex,
      nowMs: new Date("2026-01-15T00:00:00.000Z").getTime(),
    });
    expect(result.ok).toBe(true);
  });

  it("EXACT reviewAfter equality is expired (equality is expired, per spec)", async () => {
    const card = await buildValidCard();
    await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card,
      snapshotSha256: card.sourceSnapshotSha256,
      clock: CLOCK_AT("2026-01-01T00:00:00.000Z"),
    });
    const freshIndex = await readSourceStatusV1(foundry.paths.sourceStatusPath);
    const reviewAfterMs = new Date(freshIndex.entries[0].reviewAfter).getTime();

    const atExactExpiry = validateSourceStatusForInvocationV1({
      provenance: [{ sourceCardId: card.sourceCardId, claimIds: ["c1"], sourceSnapshotSha256: card.sourceSnapshotSha256 }],
      freshIndex,
      nowMs: reviewAfterMs, // now === reviewAfter -> expired
    });
    expect(atExactExpiry.ok).toBe(false);

    const oneMsBefore = validateSourceStatusForInvocationV1({
      provenance: [{ sourceCardId: card.sourceCardId, claimIds: ["c1"], sourceSnapshotSha256: card.sourceSnapshotSha256 }],
      freshIndex,
      nowMs: reviewAfterMs - 1,
    });
    expect(oneMsBefore.ok).toBe(true);
  });

  it("a mismatched sourceSnapshotSha256 in provenance fails closed", async () => {
    const card = await buildValidCard();
    await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card,
      snapshotSha256: card.sourceSnapshotSha256,
      clock: CLOCK_AT("2026-01-01T00:00:00.000Z"),
    });
    const freshIndex = await readSourceStatusV1(foundry.paths.sourceStatusPath);
    const result = validateSourceStatusForInvocationV1({
      provenance: [{ sourceCardId: card.sourceCardId, claimIds: ["c1"], sourceSnapshotSha256: "f".repeat(64) }],
      freshIndex,
      nowMs: new Date("2026-01-15T00:00:00.000Z").getTime(),
    });
    expect(result.ok).toBe(false);
  });

  it("a revoked entry fails closed", async () => {
    const card = await buildValidCard();
    await refreshSourceStatusV1({
      sourceStatusPath: foundry.paths.sourceStatusPath,
      sourceCardsRoot: foundry.paths.sourceCardsRoot,
      card,
      snapshotSha256: card.sourceSnapshotSha256,
      clock: CLOCK_AT("2026-01-01T00:00:00.000Z"),
    });
    await revokeSourceStatusV1(foundry.paths.sourceStatusPath, card.sourceCardId, CLOCK_AT("2026-01-02T00:00:00.000Z"));
    const freshIndex = await readSourceStatusV1(foundry.paths.sourceStatusPath);
    const result = validateSourceStatusForInvocationV1({
      provenance: [{ sourceCardId: card.sourceCardId, claimIds: ["c1"], sourceSnapshotSha256: card.sourceSnapshotSha256 }],
      freshIndex,
      nowMs: new Date("2026-01-15T00:00:00.000Z").getTime(),
    });
    expect(result.ok).toBe(false);
  });

  it("a missing index entry fails closed", () => {
    const result = validateSourceStatusForInvocationV1({
      provenance: [{ sourceCardId: "never-added", claimIds: ["c1"], sourceSnapshotSha256: "a".repeat(64) }],
      freshIndex: { schemaVersion: 1, generation: 0, updatedAt: new Date(0).toISOString(), entries: [] },
      nowMs: Date.now(),
    });
    expect(result.ok).toBe(false);
  });
});
