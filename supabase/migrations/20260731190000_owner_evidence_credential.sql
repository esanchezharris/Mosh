-- The plaintext owner credential never enters Supabase. The Edge Function hashes
-- each bearer candidate and compares it with this service-role-only digest.
create table if not exists public.mosh_owner_credentials (
  name text primary key,
  secret_sha256 text not null check (secret_sha256 ~ '^[a-f0-9]{64}$'),
  rotated_at timestamptz not null default now()
);

alter table public.mosh_owner_credentials enable row level security;
revoke all on table public.mosh_owner_credentials from public, anon, authenticated;
grant select on table public.mosh_owner_credentials to service_role;

drop policy if exists "owner credentials deny clients" on public.mosh_owner_credentials;
create policy "owner credentials deny clients"
on public.mosh_owner_credentials
for all
to anon, authenticated
using (false)
with check (false);

comment on table public.mosh_owner_credentials is
  'Owner-only SHA-256 credential digests read by service-role Edge Functions.';
