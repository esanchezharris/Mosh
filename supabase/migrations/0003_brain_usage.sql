-- Brain proxy: per-install DAILY TOKEN CAP bookkeeping (see functions/brain/index.ts).
--
-- Goal: bound the app's own LLM spend now that provider keys move server-side (the
-- packaged app used to bundle brain.env directly — an extractable-key ship-blocker).
-- install_id is an opaque per-install UUID (mosh::BrainProxy::installId() /
-- brain_client._install_id() / vite.config.ts's installId()) — NEVER a secret, NEVER
-- an auth boundary, just a bucket key for "how many tokens has this install used today."
--
-- Same posture as migrations/0001_mp_relay.sql: a table with RLS enabled and NO
-- policies (⇒ anon/authenticated get nothing via PostgREST), touched only through
-- SECURITY DEFINER RPCs whose EXECUTE is revoked from anon/authenticated and granted
-- to service_role only. The Edge Function (running as service_role) is the sole caller.

create table if not exists public.brain_usage_daily (
  install_id   text        not null,
  usage_day    date        not null,
  tokens_used  integer     not null default 0,
  requests     integer     not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (install_id, usage_day)
);
alter table public.brain_usage_daily enable row level security;   -- no policies => deny-all via PostgREST

-- Atomically reserve p_reserve_tokens against today's usage for p_install_id, IF the
-- install is currently under p_daily_cap. The row lock (SELECT ... FOR UPDATE) makes
-- concurrent requests from the same install serialize here, so two in-flight requests
-- can't both slip under the cap in the same instant (relay's mp_try_lock uses the same
-- row-lock-then-update shape for the same reason). Reserving BEFORE the upstream call
-- (rather than recording actual usage AFTER) means a burst can't outrun the cap while
-- waiting on the provider; brain_usage_adjust corrects the estimate to the real token
-- count once the response is in (or refunds it on a failed upstream call).
create or replace function public.brain_usage_reserve(p_install_id text, p_reserve_tokens integer, p_daily_cap integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day  date := (now() at time zone 'utc')::date;
  v_used integer;
begin
  insert into public.brain_usage_daily (install_id, usage_day, tokens_used, requests)
    values (p_install_id, v_day, 0, 0)
  on conflict (install_id, usage_day) do nothing;

  select tokens_used into v_used
    from public.brain_usage_daily
   where install_id = p_install_id and usage_day = v_day
     for update;

  if v_used >= p_daily_cap then
    return jsonb_build_object('allowed', false, 'used', v_used, 'cap', p_daily_cap);
  end if;

  update public.brain_usage_daily
     set tokens_used = tokens_used + p_reserve_tokens,
         requests    = requests + 1,
         updated_at  = now()
   where install_id = p_install_id and usage_day = v_day;

  return jsonb_build_object('allowed', true, 'used', v_used, 'cap', p_daily_cap);
end;
$$;

-- Correct a prior reserve() to the real token delta (actual_tokens - reserved_estimate).
-- Pass a NEGATIVE delta equal to -reserve_tokens to fully refund a reservation when the
-- upstream call failed outright (network error / non-2xx) so a failed request never
-- burns the install's cap. Clamped at 0 so a late/duplicate adjust can't go negative.
create or replace function public.brain_usage_adjust(p_install_id text, p_delta_tokens integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
begin
  update public.brain_usage_daily
     set tokens_used = greatest(0, tokens_used + p_delta_tokens),
         updated_at  = now()
   where install_id = p_install_id and usage_day = v_day;
end;
$$;

-- Housekeeping: a daily cap only ever needs a few days of history. Callable manually
-- (`select public.brain_usage_prune();`) or scheduled via pg_cron, same as mp.sweep()
-- (see supabase/README.md's GC section) — NOT wired up automatically by this migration.
create or replace function public.brain_usage_prune(p_keep_days integer default 7)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.brain_usage_daily
   where usage_day < (now() at time zone 'utc')::date - p_keep_days;
$$;

revoke all on public.brain_usage_daily from public, anon, authenticated;
revoke all on function
  public.brain_usage_reserve(text, integer, integer),
  public.brain_usage_adjust(text, integer),
  public.brain_usage_prune(integer)
  from public, anon, authenticated;
grant execute on function
  public.brain_usage_reserve(text, integer, integer),
  public.brain_usage_adjust(text, integer),
  public.brain_usage_prune(integer)
  to service_role;
