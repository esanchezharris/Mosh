-- Expire collaboration presence after the same 90-second grace used by track
-- locks. This is an additive migration for the live relay; 0001/0002 remain the
-- reproducible historical baseline applied before this delta on a fresh project.

create or replace function mp.expire_stale_peers(p_code text)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_removed integer;
begin
  -- Locks do not carry a peer foreign key, so release them before membership.
  delete from mp.locks l
   where l.code = p_code
     and exists (
       select 1 from mp.peers p
        where p.code = p_code
          and p.peer_id = l.owner
          and p.last_seen <= now() - interval '90 seconds'
     );
  delete from mp.peers p
   where p.code = p_code
     and p.last_seen <= now() - interval '90 seconds';
  get diagnostics v_removed = row_count;
  return v_removed;
end $$;

create or replace function mp.sweep()
returns void language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  delete from mp.rooms where expires_at < now();
  -- Match the public RPC lock order (rooms -> locks/peers). Without the room
  -- lock, a concurrent join could hold the room while waiting on a stale peer
  -- row that this sweep held, then the sweep could wait on that same room.
  for v_code in select code from mp.rooms for update loop
    perform mp.expire_stale_peers(v_code);
  end loop;
  delete from mp.locks where lease_expires_at < now() - interval '5 minutes';
  delete from mp.rooms r
   where not exists (select 1 from mp.peers p where p.code = r.code);
end $$;

create or replace function public.mp_join_room(
  p_code text, p_peer text, p_name text, p_color text
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_cap smallint; v_count int; v_peers jsonb;
begin
  select member_cap into v_cap from mp.rooms where code = p_code for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_such_room'); end if;

  -- The room row lock serializes expiry, capacity, and insertion for this code.
  perform mp.expire_stale_peers(p_code);
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

create or replace function public.mp_publish(p_code text, p_peer text, p_msg jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_type text := p_msg->>'type';
  v_key text := p_msg->>'logicalId';
  v_msg_epoch bigint := nullif(p_msg->>'epoch','')::bigint;
  v_owner text; v_cur_epoch bigint; v_seq bigint; v_member_count integer;
begin
  -- Keep the established rooms -> locks order used by mp_try_lock.
  perform 1 from mp.rooms where code = p_code and expires_at > now() for update;
  if not found then return jsonb_build_object('error','no_such_room','http_status',410); end if;
  perform mp.expire_stale_peers(p_code);
  update mp.peers set last_seen = now()
   where code = p_code and peer_id = p_peer;
  get diagnostics v_member_count = row_count;
  if v_member_count = 0 then
    return jsonb_build_object('error','not_a_member','http_status',403);
  end if;

  if v_type = 'commit' and v_key is not null then
    select owner, epoch into v_owner, v_cur_epoch
      from mp.locks where code = p_code and key = v_key for update;
    if v_owner is not null and (
      v_owner is distinct from p_peer
      or v_msg_epoch is null
      or v_msg_epoch < v_cur_epoch
    ) then
      return jsonb_build_object(
        'error','stale_commit','http_status',409,'owner',v_owner,'epoch',v_cur_epoch
      );
    end if;
  end if;
  insert into mp.messages(code, from_peer, msg)
  values (p_code, p_peer, p_msg) returning id into v_seq;
  update mp.rooms set expires_at = now() + interval '24 hours' where code = p_code;
  return jsonb_build_object('seq', v_seq);
end $$;

create or replace function public.mp_try_lock(
  p_code text, p_peer text, p_key text, p_steal boolean default false
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_new_epoch bigint; v_owner text; v_epoch bigint; v_member_count integer;
begin
  update mp.rooms set epoch_counter = epoch_counter + 1
   where code = p_code returning epoch_counter into v_new_epoch;
  if not found then return jsonb_build_object('granted', false, 'error', 'no_such_room'); end if;
  perform mp.expire_stale_peers(p_code);
  update mp.peers set last_seen = now()
   where code = p_code and peer_id = p_peer;
  get diagnostics v_member_count = row_count;
  if v_member_count = 0 then
    return jsonb_build_object('granted',false,'error','not_a_member','http_status',403);
  end if;

  insert into mp.locks(code, key, owner, epoch, lease_expires_at)
  values (p_code, p_key, p_peer, v_new_epoch, now() + interval '90 seconds')
  on conflict (code, key) do update
    set owner = excluded.owner, epoch = excluded.epoch,
        acquired_at = now(), lease_expires_at = excluded.lease_expires_at
    where mp.locks.owner = p_peer or mp.locks.lease_expires_at < now() or p_steal
  returning owner, epoch into v_owner, v_epoch;
  if v_owner is null then
    select owner, epoch into v_owner, v_epoch
      from mp.locks where code = p_code and key = p_key;
    return jsonb_build_object('granted', false, 'owner', v_owner, 'epoch', v_epoch);
  end if;
  return jsonb_build_object('granted', true, 'owner', v_owner, 'epoch', v_epoch);
end $$;

create or replace function public.mp_events(p_code text, p_peer text, p_since bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_frames jsonb; v_latest bigint; v_locks jsonb; v_peers jsonb;
  v_member_count integer;
begin
  perform 1 from mp.rooms where code = p_code and expires_at > now() for update;
  if not found then
    return jsonb_build_object(
      'frames','[]'::jsonb,'latest',p_since,'resync',false,
      'locks','{}'::jsonb,'peers','{}'::jsonb,'error','no_such_room','http_status',410
    );
  end if;
  perform mp.expire_stale_peers(p_code);
  update mp.peers set last_seen = now()
   where code = p_code and peer_id = p_peer;
  get diagnostics v_member_count = row_count;
  if v_member_count = 0 then
    return jsonb_build_object(
      'frames','[]'::jsonb,'latest',p_since,'resync',false,
      'locks','{}'::jsonb,'peers','{}'::jsonb,'error','not_a_member','http_status',403
    );
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object('seq',id,'from',from_peer,'msg',msg) order by id
         ), '[]'::jsonb)
    into v_frames from mp.messages
   where code = p_code and id > p_since and from_peer <> p_peer;
  select coalesce(max(id), p_since) into v_latest
    from mp.messages where code = p_code;
  select coalesce(jsonb_object_agg(key, owner), '{}'::jsonb)
    into v_locks from mp.locks
   where code = p_code and lease_expires_at > now();
  select coalesce(jsonb_object_agg(
           peer_id,
           jsonb_build_object(
             'name',name,'color',color,
             'online',last_seen > now() - interval '30 seconds'
           )
         ), '{}'::jsonb)
    into v_peers from mp.peers where code = p_code;
  update mp.rooms set expires_at = now() + interval '24 hours' where code = p_code;
  return jsonb_build_object(
    'frames',v_frames,'latest',v_latest,'resync',false,'locks',v_locks,'peers',v_peers
  );
end $$;

create or replace function public.mp_is_member(p_code text, p_peer text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from mp.peers pe
    join mp.rooms r on r.code = pe.code and r.expires_at > now()
    where pe.code = p_code
      and pe.peer_id = p_peer
      and pe.last_seen > now() - interval '90 seconds'
  );
$$;

revoke all on function mp.expire_stale_peers(text) from public, anon, authenticated;
revoke all on function
  public.mp_join_room(text,text,text,text), public.mp_publish(text,text,jsonb),
  public.mp_try_lock(text,text,text,boolean), public.mp_events(text,text,bigint),
  public.mp_is_member(text,text)
  from public, anon, authenticated;
grant execute on function
  public.mp_join_room(text,text,text,text), public.mp_publish(text,text,jsonb),
  public.mp_try_lock(text,text,text,boolean), public.mp_events(text,text,bigint),
  public.mp_is_member(text,text)
  to service_role;
