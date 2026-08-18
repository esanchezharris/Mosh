// Task 2 — Close the Primitive Catalog and Validate Manifests.
//
// RED-first pin for the closed owner-local primitive/predicate catalogs (spec Section
// 8.4's "V1 owner-local allowlist" table) and the native-skill ID universe. The exact key
// sets below ARE the closed vocabulary a v1 owner-local manifest may reference — expanding
// any of them requires a normal code review and a catalog-version bump (spec 8.4), so this
// test is the guard that makes an accidental widening fail loudly.

import { describe, expect, it } from "vitest";
import {
  NATIVE_SKILL_IDS_V1,
  NATIVE_SKILL_LEGACY_ALIASES_V1,
  OWNER_PREDICATES_V1,
  OWNER_PRIMITIVES_V1,
  PREDICATE_CATALOG_VERSION_V1,
  RESOLVER_CATALOG_VERSION_V1,
  catalogFingerprintV1,
} from "./catalogs";
import { canonicalJsonBytes, sha256Bytes } from "./hash";

describe("NATIVE_SKILL_IDS_V1", () => {
  it("is the exact pinned four-entry native ID universe, in order", () => {
    expect(NATIVE_SKILL_IDS_V1).toEqual([
      "session-control",
      "capture-review-choose-take",
      "explicit-balance",
      "load-named-plugin",
    ]);
  });

  it("has exactly the one documented legacy alias", () => {
    expect(NATIVE_SKILL_LEGACY_ALIASES_V1).toEqual({ load_named_plugin: "load-named-plugin" });
  });
});

describe("OWNER_PRIMITIVES_V1", () => {
  it("has the exact closed observation set", () => {
    expect(Object.keys(OWNER_PRIMITIVES_V1.observations)).toEqual(["current_snapshot", "list_plugins"]);
  });

  it("has the exact closed resolver set", () => {
    expect(Object.keys(OWNER_PRIMITIVES_V1.resolvers)).toEqual([
      "selected_track",
      "track_by_unique_name",
      "plugin_by_name",
    ]);
  });

  it("has the exact closed mutation set", () => {
    expect(Object.keys(OWNER_PRIMITIVES_V1.mutations)).toEqual([
      "set_track_volume",
      "set_track_mute",
      "set_track_solo",
      "load_plugin",
    ]);
  });

  it("keeps every observation/resolver read_only and every mutation mutation-classed", () => {
    for (const descriptor of Object.values(OWNER_PRIMITIVES_V1.observations)) {
      expect(descriptor.transactionClass).toBe("read_only");
    }
    for (const descriptor of Object.values(OWNER_PRIMITIVES_V1.resolvers)) {
      expect(descriptor.transactionClass).toBe("read_only");
    }
    for (const descriptor of Object.values(OWNER_PRIMITIVES_V1.mutations)) {
      expect(descriptor.transactionClass).toBe("mutation");
    }
  });

  it("bounds the volume argument to -60..+6 dB", () => {
    expect(OWNER_PRIMITIVES_V1.mutations.set_track_volume.args.db).toMatchObject({
      minimum: -60,
      maximum: 6,
    });
  });

  it("restricts trackId to a resolver binding or the selected-track context, never a literal", () => {
    const trackIdArg = OWNER_PRIMITIVES_V1.mutations.set_track_volume.args.trackId;
    expect(trackIdArg.allowedSources).not.toContain("literal");
    expect(trackIdArg.allowedSources).toContain("binding");
    expect(trackIdArg.allowedSources).toContain("context");
  });

  it("restricts pluginId to only the plugin_by_name binding", () => {
    const pluginIdArg = OWNER_PRIMITIVES_V1.mutations.load_plugin.args.pluginId;
    expect(pluginIdArg.allowedSources).toEqual(["binding"]);
    expect(pluginIdArg.boundResolvers).toEqual(["plugin_by_name"]);
  });
});

describe("OWNER_PREDICATES_V1", () => {
  it("has the exact closed predicate set", () => {
    expect(Object.keys(OWNER_PREDICATES_V1)).toEqual([
      "not_recording",
      "project_epoch_unchanged",
      "selected_track_is",
      "track_exists",
      "track_volume_equals",
      "track_mute_equals",
      "track_solo_equals",
      "plugin_instance_added_once",
    ]);
  });
});

describe("catalogFingerprintV1", () => {
  it("returns schemaVersion 1 and the hand-bumped predicate/resolver catalog versions", async () => {
    const fingerprint = await catalogFingerprintV1();
    expect(fingerprint.schemaVersion).toBe(1);
    expect(fingerprint.predicateCatalogVersion).toBe(PREDICATE_CATALOG_VERSION_V1);
    expect(fingerprint.resolverCatalogVersion).toBe(RESOLVER_CATALOG_VERSION_V1);
  });

  it("hashes exactly the observations+mutations descriptors keyed by primitive name", async () => {
    const expected = await sha256Bytes(
      canonicalJsonBytes({ ...OWNER_PRIMITIVES_V1.observations, ...OWNER_PRIMITIVES_V1.mutations }),
    );
    const fingerprint = await catalogFingerprintV1();
    expect(fingerprint.commandCatalogSha256).toBe(expected);
  });

  it("is deterministic across calls", async () => {
    const a = await catalogFingerprintV1();
    const b = await catalogFingerprintV1();
    expect(a).toEqual(b);
  });

  it("excludes resolvers from the command-catalog hash", async () => {
    const withResolvers = await sha256Bytes(
      canonicalJsonBytes({
        ...OWNER_PRIMITIVES_V1.observations,
        ...OWNER_PRIMITIVES_V1.resolvers,
        ...OWNER_PRIMITIVES_V1.mutations,
      }),
    );
    const fingerprint = await catalogFingerprintV1();
    expect(fingerprint.commandCatalogSha256).not.toBe(withResolvers);
  });
});
