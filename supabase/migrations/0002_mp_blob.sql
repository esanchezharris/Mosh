-- P4 audio stems: a PRIVATE content-addressed bucket + the membership gate the
-- Edge Function uses before minting signed upload/download URLs.

insert into storage.buckets (id, name, public, file_size_limit)
values ('mp-stems', 'mp-stems', false, 52428800)   -- 50 MB (Free-tier per-file ceiling)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- Is this peer a member of a live room? (gate for /mp/blob/{put-url,get-url,head})
create or replace function public.mp_is_member(p_code text, p_peer text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from mp.peers pe
    join mp.rooms r on r.code = pe.code and r.expires_at > now()
    where pe.code = p_code and pe.peer_id = p_peer
  );
$$;
revoke all on function public.mp_is_member(text,text) from public, anon, authenticated;
grant execute on function public.mp_is_member(text,text) to service_role;
