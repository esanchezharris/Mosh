-- Mosh multiplayer relay — Postgres port of relay/room.py (Postgres 17).
--
-- Consolidated final state (the live project tpvkqaqydafpgockzchm was built via two
-- connector migrations: mp_relay_init then mp_relay_public_rpcs; this single file
-- re-provisions the same end state on a fresh project).
--
-- Design: tables live in a PRIVATE schema `mp` (RLS-denied, never exposed to
-- PostgREST). The arbitration logic is a set of SECURITY DEFINER RPCs in `public`
-- (PostgREST-exposed, but execute-locked to service_role) — one RPC == one
-- transaction, so try_lock (epoch mint + grant) and publish (fence + seq) are
-- race-free. The Edge Function (supabase/functions/relay) calls these as service_role.

create schema if not exists mp;
create extension if not exists pgcrypto with schema extensions;

-- ---------- TABLES (private) ----------
create table if not exists mp.rooms (
  code           text primary key,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '24 hours',
  epoch_counter  bigint      not null default 0,   -- per-room monotonic fencing token
  member_cap     smallint    not null default 2
);
create table if not exists mp.peers (
  code      text not null references mp.rooms(code) on delete cascade,
  peer_id   text not null,
  name      text not null default '',
  color     text not null default '',
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (code, peer_id)
);
create table if not exists mp.messages (
  id         bigserial primary key,            -- THE seq (global serial; per-room order via code filter)
  code       text not null references mp.rooms(code) on delete cascade,
  from_peer  text not null,
  msg        jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_code_id on mp.messages (code, id);
create table if not exists mp.locks (
  code             text not null references mp.rooms(code) on delete cascade,
  key              text not null,              -- a track's moshLogicalId (or a session key)
  owner            text not null,
  epoch            bigint not null,
  acquired_at      timestamptz not null default now(),
  lease_expires_at timestamptz not null default now() + interval '90 seconds',
  primary key (code, key)
);

alter table mp.rooms    enable row level security;
alter table mp.peers    enable row level security;
alter table mp.messages enable row level security;
alter table mp.locks    enable row level security;   -- no policies => anon/authenticated get nothing

-- ---------- helpers (private) ----------
create or replace function mp.gen_code()
returns text language sql volatile security definer set search_path = '' as $$
  select translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/=', '-_');
$$;

create or replace function mp.sweep()           -- GC; pg_cron drives it (see README)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from mp.rooms where expires_at < now();
  delete from mp.locks where lease_expires_at < now() - interval '5 minutes';
  delete from mp.rooms r
   where not exists (select 1 from mp.peers p
                     where p.code = r.code and p.last_seen > now() - interval '10 minutes');
end $$;

-- ---------- RPCs (public, PostgREST-exposed, service_role-only) ----------
create or replace function public.mp_create_room(p_peer text, p_name text, p_color text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_code text; v_try int := 0;
begin
  loop
    v_code := mp.gen_code();
    begin insert into mp.rooms(code) values (v_code); exit;
    exception when unique_violation then
      v_try := v_try + 1; if v_try > 5 then raise exception 'code_gen_failed'; end if;
    end;
  end loop;
  insert into mp.peers(code, peer_id, name, color)
  values (v_code, p_peer, coalesce(p_name,''), coalesce(p_color,''));
  return jsonb_build_object('code', v_code, 'peerId', p_peer);
end $$;

create or replace function public.mp_join_room(p_code text, p_peer text, p_name text, p_color text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_cap smallint; v_count int; v_peers jsonb;
begin
  select member_cap into v_cap from mp.rooms where code = p_code for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_such_room'); end if;
  select count(*) into v_count from mp.peers where code = p_code and peer_id <> p_peer;
  if not exists (select 1 from mp.peers where code = p_code and peer_id = p_peer)
     and v_count >= v_cap then
    return jsonb_build_object('ok', false, 'error', 'room_full');
  end if;
  insert into mp.peers(code, peer_id, name, color)
  values (p_code, p_peer, coalesce(p_name,''), coalesce(p_color,''))
  on conflict (code, peer_id) do update
    set name = excluded.name, color = excluded.color, last_seen = now();
  update mp.rooms set expires_at = now() + interval '24 hours' where code = p_code;
  select coalesce(jsonb_object_agg(peer_id,
           jsonb_build_object('name', name, 'color', color, 'online', true)), '{}'::jsonb)
    into v_peers from mp.peers where code = p_code;
  return jsonb_build_object('ok', true, 'peers', v_peers);
end $$;

-- publish: seq = inserted id; epoch fence keyed on the commit's logicalId -> 409 on stale/zombie
create or replace function public.mp_publish(p_code text, p_peer text, p_msg jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_type text := p_msg->>'type';
  v_key  text := p_msg->>'logicalId';
  v_msg_epoch bigint := nullif(p_msg->>'epoch','')::bigint;
  v_owner text; v_cur_epoch bigint; v_seq bigint;
begin
  -- Row-lock the room FIRST (before mp.locks below), so this RPC acquires its locks
  -- in the SAME rooms -> locks order as mp_try_lock (which row-locks mp.rooms via its
  -- epoch_counter UPDATE before touching mp.locks). Consistent ordering means a
  -- concurrent commit + steal cannot form an AB-BA deadlock (40P01).
  perform 1 from mp.rooms where code = p_code and expires_at > now() for update;
  if not found then return jsonb_build_object('error','no_such_room','http_status',410); end if;
  if v_type = 'commit' and v_key is not null then
    -- FOR UPDATE row-locks the lock so a concurrent mp_try_lock(steal) cannot commit
    -- BETWEEN this fence read and the message insert (TOCTOU): we block until any
    -- in-flight steal commits, then read the fresh owner/epoch and fence correctly.
    -- (No row => unlocked/lapsed key => nothing to lock => commit allowed, as before.)
    select owner, epoch into v_owner, v_cur_epoch
      from mp.locks where code = p_code and key = v_key for update;
    if v_owner is not null and (v_owner is distinct from p_peer or v_msg_epoch is null or v_msg_epoch < v_cur_epoch) then
      return jsonb_build_object('error','stale_commit','http_status',409,'owner', v_owner, 'epoch', v_cur_epoch);
    end if;
  end if;
  insert into mp.messages(code, from_peer, msg) values (p_code, p_peer, p_msg) returning id into v_seq;
  update mp.peers set last_seen = now() where code = p_code and peer_id = p_peer;
  update mp.rooms set expires_at = now() + interval '24 hours' where code = p_code;
  return jsonb_build_object('seq', v_seq);
end $$;

create or replace function public.mp_try_lock(p_code text, p_peer text, p_key text, p_steal boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_new_epoch bigint; v_owner text; v_epoch bigint;
begin
  update mp.rooms set epoch_counter = epoch_counter + 1 where code = p_code returning epoch_counter into v_new_epoch;
  if not found then return jsonb_build_object('granted', false, 'error', 'no_such_room'); end if;
  insert into mp.locks(code, key, owner, epoch, lease_expires_at)
  values (p_code, p_key, p_peer, v_new_epoch, now() + interval '90 seconds')
  on conflict (code, key) do update
    set owner = excluded.owner, epoch = excluded.epoch, acquired_at = now(), lease_expires_at = excluded.lease_expires_at
    where mp.locks.owner = p_peer or mp.locks.lease_expires_at < now() or p_steal
  returning owner, epoch into v_owner, v_epoch;
  if v_owner is null then
    select owner, epoch into v_owner, v_epoch from mp.locks where code = p_code and key = p_key;
    return jsonb_build_object('granted', false, 'owner', v_owner, 'epoch', v_epoch);
  end if;
  return jsonb_build_object('granted', true, 'owner', v_owner, 'epoch', v_epoch);
end $$;

create or replace function public.mp_unlock(p_code text, p_peer text, p_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_deleted int;
begin
  delete from mp.locks where code = p_code and key = p_key and owner = p_peer;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('released', v_deleted > 0);
end $$;

create or replace function public.mp_leave(p_code text, p_peer text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_remaining int;
begin
  delete from mp.locks where code = p_code and owner = p_peer;
  delete from mp.peers where code = p_code and peer_id = p_peer;
  select count(*) into v_remaining from mp.peers where code = p_code;
  if v_remaining = 0 then delete from mp.rooms where code = p_code; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.mp_events(p_code text, p_peer text, p_since bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_frames jsonb; v_latest bigint; v_locks jsonb; v_peers jsonb;
begin
  perform 1 from mp.rooms where code = p_code;
  if not found then
    return jsonb_build_object('frames','[]'::jsonb,'latest',p_since,'resync',false,'locks','{}'::jsonb,'peers','{}'::jsonb,'error','no_such_room');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('seq',id,'from',from_peer,'msg',msg) order by id), '[]'::jsonb)
    into v_frames from mp.messages where code = p_code and id > p_since and from_peer <> p_peer;   -- no echo
  select coalesce(max(id), p_since) into v_latest from mp.messages where code = p_code;
  select coalesce(jsonb_object_agg(key, owner), '{}'::jsonb) into v_locks from mp.locks where code = p_code and lease_expires_at > now();
  select coalesce(jsonb_object_agg(peer_id, jsonb_build_object('name',name,'color',color,'online', last_seen > now() - interval '30 seconds')), '{}'::jsonb)
    into v_peers from mp.peers where code = p_code;
  update mp.peers set last_seen = now() where code = p_code and peer_id = p_peer;   -- presence heartbeat
  return jsonb_build_object('frames',v_frames,'latest',v_latest,'resync',false,'locks',v_locks,'peers',v_peers);
end $$;

-- ---------- lock execution to service_role (the Edge Function) ----------
revoke all on function
  public.mp_create_room(text,text,text), public.mp_join_room(text,text,text,text),
  public.mp_publish(text,text,jsonb), public.mp_try_lock(text,text,text,boolean),
  public.mp_unlock(text,text,text), public.mp_leave(text,text), public.mp_events(text,text,bigint)
  from public, anon, authenticated;
grant execute on function
  public.mp_create_room(text,text,text), public.mp_join_room(text,text,text,text),
  public.mp_publish(text,text,jsonb), public.mp_try_lock(text,text,text,boolean),
  public.mp_unlock(text,text,text), public.mp_leave(text,text), public.mp_events(text,text,bigint)
  to service_role;
