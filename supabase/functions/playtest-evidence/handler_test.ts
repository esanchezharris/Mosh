import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createEvidenceHandler, type EvidenceStorage } from "./handler.ts";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
]);
const ids = {
  evidence: "11111111-1111-4111-8111-111111111111",
  playtest: "22222222-2222-4222-8222-222222222222",
  report: "33333333-3333-4333-8333-333333333333",
};

class FakeStorage implements EvidenceStorage {
  writes: Array<{ path: string; bytes: Uint8Array; contentType: string; upsert: boolean }> = [];
  private readonly paths = new Set<string>();

  async upload(path: string, bytes: Uint8Array, options: { contentType: string; upsert: false }) {
    if (this.paths.has(path)) throw new Error("duplicate");
    this.paths.add(path);
    this.writes.push({ path, bytes, ...options });
  }

  async signedUrl(path: string, expiresInSeconds: number) {
    return { url: `https://signed.invalid/${path}`, expiresInSeconds };
  }
}

function request(body: Uint8Array, secret = "owner-secret", contentType = "image/png") {
  return new Request("https://edge.invalid/playtest-evidence", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": contentType,
      "x-mosh-evidence-id": ids.evidence,
      "x-mosh-playtest-id": ids.playtest,
      "x-mosh-report-id": ids.report,
    },
    body: new Uint8Array(body).buffer as ArrayBuffer,
  });
}

Deno.test("evidence handler requires owner secret before storage access", async () => {
  const storage = new FakeStorage();
  const handler = createEvidenceHandler({ ownerSecret: "owner-secret", storage });
  assertEquals((await handler(request(PNG, "wrong"))).status, 401);
  assertEquals(storage.writes, []);
});

Deno.test("evidence handler rejects MIME, signature, and bounded-size violations", async () => {
  const storage = new FakeStorage();
  const handler = createEvidenceHandler({ ownerSecret: "owner-secret", storage, maxBytes: PNG.length });
  assertEquals((await handler(request(PNG, "owner-secret", "image/jpeg"))).status, 415);
  assertEquals((await handler(request(new Uint8Array([1, 2, 3])))).status, 415);
  assertEquals((await handler(request(new Uint8Array([...PNG, 2])))).status, 413);
  assertEquals(storage.writes, []);
});

Deno.test("evidence handler writes one immutable path, checksum, and five-minute preview", async () => {
  const storage = new FakeStorage();
  const handler = createEvidenceHandler({ ownerSecret: "owner-secret", storage });
  const response = await handler(request(PNG));
  assertEquals(response.status, 200);
  assertEquals(storage.writes[0], {
    path: `${ids.playtest}/${ids.report}/${ids.evidence}.png`,
    bytes: PNG,
    contentType: "image/png",
    upsert: false,
  });
  const body = await response.json();
  assertEquals(body.evidenceId, ids.evidence);
  assertEquals(body.objectPath, `${ids.playtest}/${ids.report}/${ids.evidence}.png`);
  assertEquals(body.sha256, "275f1bcbbb585c71e3b2184304eccfa0e37de92022ca3b6f4e9c10df32318d85");
  assertEquals(body.previewUrl, `https://signed.invalid/${body.objectPath}`);
  assertEquals(storage.writes.length, 1);
  await assertRejects(
    () => storage.upload(body.objectPath, PNG, { contentType: "image/png", upsert: false }),
  );
});
