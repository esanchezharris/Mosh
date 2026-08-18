// Skill Foundry Slice B — owner decision, CODE-BOUND SEEDING: precedence proof.
//
// `mergeCodeBoundNativeCandidatesV1` (runtime.ts) is the rule `buildDefaultRuntimeV1` uses to
// combine `loadBundledNativeSkillsV1`'s real `.accepted` (an EXTERNAL artifact-graph load —
// post-ship native staging, Slice E) with `buildCodeBoundNativeSkillCandidatesV1()`'s
// compiled-in seed (the owner's fix for the empty-registry regression, 0e860fea): a bundled-
// index-accepted entry WINS over a code-bound one with the same id, so a later staged update
// to a core skill can shadow the shipped default without an app release.
//
// This file proves that rule directly against the pure merge function — no need to stand up a
// full hash-chain artifact-graph fixture through the bridge to prove a precedence RULE, only to
// prove the real loader eventually calls the rule (proved separately: runtime.defaultRuntime.test.ts
// exercises the full default-runtime boot end to end; buildDefaultRuntimeV1's own header
// documents that it delegates the precedence decision to this exact function).

import { describe, expect, it } from "vitest";
import type { RegisteredSkillV1 } from "./contracts";
import { buildStudioSkillRegistryV1 } from "./registry";
import { mergeCodeBoundNativeCandidatesV1 } from "./runtime";
import { NATIVE_PAYLOADS_V1 } from "./native/index";

const CODE_BOUND_LOAD_NAMED_PLUGIN = NATIVE_PAYLOADS_V1.find((p) => p.id === "load-named-plugin");
if (!CODE_BOUND_LOAD_NAMED_PLUGIN) throw new Error("test fixture: load-named-plugin payload missing from NATIVE_PAYLOADS_V1");

/** A fixture "bundled-index-accepted" candidate — distinguishable from the code-bound one by
 *  version/description, standing in for a post-ship Slice E staged update (this test does not
 *  need a full hash-chain artifact graph to prove the PRECEDENCE rule — that the real loader
 *  calls this rule is proved by buildDefaultRuntimeV1's own wiring + runtime.defaultRuntime.test.ts). */
function bundledLoadNamedPluginCandidate(): RegisteredSkillV1 {
  return {
    id: "load-named-plugin",
    origin: "native",
    aliases: ["load_named_plugin"],
    manifest: { ...CODE_BOUND_LOAD_NAMED_PLUGIN!, version: "9.9.9", title: "Bundled: Resolve and load a named plug-in" },
  };
}

function codeBoundCandidates(): readonly RegisteredSkillV1[] {
  return NATIVE_PAYLOADS_V1.map((payload) => ({
    id: payload.id,
    origin: "native" as const,
    aliases: payload.legacyAliases,
    manifest: payload,
  }));
}

describe("mergeCodeBoundNativeCandidatesV1 — precedence proof", () => {
  it("a bundled-accepted entry WINS over the code-bound one with the same id — exactly one candidate, the bundled one", () => {
    const bundled = [bundledLoadNamedPluginCandidate()];
    const codeBound = codeBoundCandidates();

    const merged = mergeCodeBoundNativeCandidatesV1(bundled, codeBound);

    const loadNamedPluginEntries = merged.filter((c) => c.id === "load-named-plugin");
    expect(loadNamedPluginEntries).toHaveLength(1);
    expect(loadNamedPluginEntries[0]).toBe(bundled[0]); // the BUNDLED object, not the code-bound one
    expect(loadNamedPluginEntries[0]?.manifest).toMatchObject({ version: "9.9.9" });

    // The other three code-bound core skills are still present unchanged (precedence is
    // per-id, not "bundled present at all disables code-bound seeding").
    expect(merged.map((c) => c.id).sort()).toEqual(
      ["capture-review-choose-take", "explicit-balance", "load-named-plugin", "session-control"].sort(),
    );
  });

  it("feeding the merged candidates into buildStudioSkillRegistryV1 admits all four with NO duplicate_identity failure", async () => {
    const bundled = [bundledLoadNamedPluginCandidate()];
    const codeBound = codeBoundCandidates();
    const merged = mergeCodeBoundNativeCandidatesV1(bundled, codeBound);

    const result = await buildStudioSkillRegistryV1({ generation: 1, native: merged, builtin: [], owner: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.list()).toHaveLength(4);
    const registered = result.registry.get("load-named-plugin");
    expect(registered?.manifest).toMatchObject({ version: "9.9.9" });
  });

  it("with NO bundled entry, the code-bound candidate is used (the pre-existing single-source case)", () => {
    const merged = mergeCodeBoundNativeCandidatesV1([], codeBoundCandidates());
    const loadNamedPluginEntries = merged.filter((c) => c.id === "load-named-plugin");
    expect(loadNamedPluginEntries).toHaveLength(1);
    expect(loadNamedPluginEntries[0]?.manifest).toMatchObject({ version: "1.0.0" });
  });
});
