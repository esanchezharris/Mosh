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

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function authorize(candidate: string): Promise<boolean> {
  const digest = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(candidate)));
  const { data, error } = await client
    .from("mosh_owner_credentials")
    .select("secret_sha256")
    .eq("name", "playtest_evidence")
    .maybeSingle();
  if (error || !data) return false;
  return data.secret_sha256 === digest;
}

Deno.serve(createEvidenceHandler({ authorize, storage }));
