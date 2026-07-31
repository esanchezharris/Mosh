import { createClient } from "jsr:@supabase/supabase-js@2";
import { createEvidenceHandler, type EvidenceStorage } from "./handler.ts";

const bucket = "playtest-evidence";
const client = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const storage: EvidenceStorage = {
  async upload(path, bytes, options) {
    const { error } = await client.storage.from(bucket).upload(path, bytes, options);
    if (error) throw error;
  },
  async signedUrl(path, expiresInSeconds) {
    const { data, error } = await client.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
    if (error) throw error;
    return { url: data.signedUrl, expiresInSeconds };
  },
};

const ownerSecret = Deno.env.get("MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET");
if (!ownerSecret) throw new Error("MOSH_PLAYTEST_EVIDENCE_OWNER_SECRET is required");

Deno.serve(createEvidenceHandler({ ownerSecret, storage }));
