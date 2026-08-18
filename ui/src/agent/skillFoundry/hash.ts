// Task 1 — exact-byte and canonical hashing for the Skill Foundry.
//
// `sha256Bytes` hashes EXACT stored bytes — artifact bytes (manifest/report/approval/
// release/native payload/source files) are hashed as-is and are NEVER canonicalized.
// `canonicalJsonBytes` is only for DERIVED fingerprints (catalog fingerprints, native
// source-byte-set digests, confirmation-plan digests) where key order must not matter.
// Do not swap these two uses.

/** UTF-8 encode a string to bytes. */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Lowercase hex SHA-256 of exact bytes, via Web Crypto. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // Copy defensively: a caller's later mutation of a shared backing buffer must never
  // change what was hashed.
  //
  // Pass the VIEW, not `copy.buffer`. This used to hand over the raw ArrayBuffer to
  // satisfy TS's lib.dom types (which declare `digest` over a plain `ArrayBuffer`,
  // which a `Uint8Array<ArrayBufferLike>` does not structurally match on TS 5.9), on
  // the stated assumption that "every runtime accepts either". That assumption is
  // FALSE on Node 20 — the version CI runs — where the raw buffer is rejected with
  //
  //     Failed to execute 'digest' on 'SubtleCrypto': 2nd argument is not
  //     instance of ArrayBuffer, Buffer, TypedArray, or DataView
  //
  // while the typed-array view is accepted. Node 24 accepts both, which is why this
  // passed locally and failed only on the runner. Measured on both versions inside
  // the real vitest+jsdom environment, not inferred.
  //
  // So the cast moves to the argument: a typing workaround must not change what the
  // runtime is handed.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const CANONICAL_JSON_UNSUPPORTED = "canonicalJsonBytes: unsupported value";

/**
 * Recursively sort object keys, preserve array order, and reject anything that is not
 * exactly representable: `undefined`, functions, symbols, bigints, non-finite numbers,
 * and cyclic references. Never used on raw artifact bytes — only on derived fingerprints.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  const canonical = canonicalize(value, new Set<object>());
  return utf8Bytes(JSON.stringify(canonical));
}

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null) return null;
  const kind = typeof value;

  if (kind === "string" || kind === "boolean") return value;

  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`${CANONICAL_JSON_UNSUPPORTED}: non-finite number`);
    }
    return value;
  }

  if (kind === "undefined") throw new Error(`${CANONICAL_JSON_UNSUPPORTED}: undefined`);
  if (kind === "function") throw new Error(`${CANONICAL_JSON_UNSUPPORTED}: function`);
  if (kind === "symbol") throw new Error(`${CANONICAL_JSON_UNSUPPORTED}: symbol`);
  if (kind === "bigint") throw new Error(`${CANONICAL_JSON_UNSUPPORTED}: bigint`);

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${CANONICAL_JSON_UNSUPPORTED}: cyclic reference`);
    seen.add(value);
    try {
      return value.map((item) => canonicalize(item, seen));
    } finally {
      seen.delete(value);
    }
  }

  if (kind === "object") {
    const record = value as object;
    if (seen.has(record)) throw new Error(`${CANONICAL_JSON_UNSUPPORTED}: cyclic reference`);
    seen.add(record);
    try {
      const input = record as Record<string, unknown>;
      const sortedKeys = Object.keys(input).sort();
      const output: Record<string, unknown> = {};
      for (const key of sortedKeys) {
        output[key] = canonicalize(input[key], seen);
      }
      return output;
    } finally {
      seen.delete(record);
    }
  }

  throw new Error(`${CANONICAL_JSON_UNSUPPORTED}: ${kind}`);
}
