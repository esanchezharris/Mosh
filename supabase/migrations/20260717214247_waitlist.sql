-- Marketing-site email waitlist (landing/). Public-facing insert-only capture: the
-- landing page POSTs directly to PostgREST using the project's anon/publishable key
-- by default (see landing/.env.example + landing/DEPLOY.md; PUBLIC_WAITLIST_URL can
-- point it at a different backend entirely instead).
--
-- Unlike 0001_mp_relay.sql's mp.* tables (private schema, execute locked to
-- service_role, reached only through the relay Edge Function's RPCs), this table is
-- DELIBERATELY public-schema and PostgREST-reachable — the whole point is a
-- zero-backend anon INSERT from a static site with no server of its own. RLS is the
-- entire access boundary: anon may INSERT and nothing else, so the table can never be
-- scraped back out over the API, not even the address a visitor just submitted. Read
-- access (e.g. a CSV export when it's time to send invites) is left to the dashboard
-- / service_role, which bypasses RLS as usual.
--
-- NOT applied automatically — this file is committed for the owner to run against
-- whichever Supabase project they choose (the existing Mosh project, or a separate
-- one dedicated to the marketing site) when ready. See landing/DEPLOY.md.

create table if not exists public.waitlist (
  id         bigserial   primary key,
  email      text        not null check (
               char_length(email) <= 320
               and email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'
             ),
  created_at timestamptz not null default now(),
  source     text        not null default 'landing' check (char_length(source) <= 64)
);

-- Case-insensitive de-dup: re-joining with different casing of the same address is a
-- no-op, not a second row. The client (landing/src/waitlist.ts) treats the resulting
-- 409 as a friendly "you're already on the list" success, not an error.
create unique index if not exists waitlist_email_lower_key on public.waitlist (lower(email));

alter table public.waitlist enable row level security;

-- Table-level privilege: without this, the RLS policy below is moot (a role needs
-- both the privilege AND a satisfying policy to do anything).
grant insert on public.waitlist to anon;

-- INSERT-only for the anon (publishable-key) role. No select/update/delete policy
-- exists for anon or authenticated, so the API can never read, edit, or delete rows —
-- only add them.
create policy "anon can join the waitlist"
  on public.waitlist
  for insert
  to anon
  with check (true);
