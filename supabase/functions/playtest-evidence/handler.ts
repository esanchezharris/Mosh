export interface EvidenceStorage {
  upload(
    path: string,
    bytes: Uint8Array,
    options: { contentType: string; upsert: false },
  ): Promise<void>;
  signedUrl(path: string, expiresInSeconds: number): Promise<{
    url: string;
    expiresInSeconds: number;
  }>;
}

type Options = {
  authorize: (candidate: string) => Promise<boolean>;
  storage: EvidenceStorage;
  maxBytes?: number;
  now?: () => number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PREVIEW_SECONDS = 300;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function createEvidenceHandler(options: Options) {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const authorization = request.headers.get("authorization") ?? "";
    const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!candidate || !await options.authorize(candidate)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "image/png") {
      return json({ error: "png_required" }, 415);
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > maxBytes) return json({ error: "body_too_large" }, 413);
    const evidenceId = request.headers.get("x-mosh-evidence-id") ?? "";
    const playtestId = request.headers.get("x-mosh-playtest-id") ?? "";
    const reportId = request.headers.get("x-mosh-report-id") ?? "";
    if (![evidenceId, playtestId, reportId].every((value) => UUID.test(value))) {
      return json({ error: "invalid_identity" }, 400);
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > maxBytes) return json({ error: "body_too_large" }, 413);
    if (bytes.length < PNG_SIGNATURE.length
      || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
      return json({ error: "png_required" }, 415);
    }
    const objectPath = `${playtestId}/${reportId}/${evidenceId}.png`;
    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    try {
      await options.storage.upload(objectPath, bytes, { contentType: "image/png", upsert: false });
    } catch {
      return json({ error: "immutable_evidence_exists" }, 409);
    }
    const signed = await options.storage.signedUrl(objectPath, PREVIEW_SECONDS);
    const now = options.now?.() ?? Date.now();
    return json({
      evidenceId,
      sha256,
      objectPath,
      previewUrl: signed.url,
      previewExpiresAt: new Date(now + signed.expiresInSeconds * 1000).toISOString(),
    });
  };
}
