-- Owner-only playtest screenshots. The Edge Function holds the service role and
-- writes immutable paths; no browser or authenticated-user policy grants access.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'playtest-evidence',
  'playtest-evidence',
  false,
  5242880,
  array['image/png']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Supabase owns storage.objects and enables RLS on the managed table. Repeating
-- ALTER TABLE here fails through the hosted migration API because the migration
-- role is intentionally not the table owner.

drop policy if exists "playtest evidence deny authenticated reads" on storage.objects;
create policy "playtest evidence deny authenticated reads"
on storage.objects
for select
to authenticated
using (false);

drop policy if exists "playtest evidence deny authenticated writes" on storage.objects;
create policy "playtest evidence deny authenticated writes"
on storage.objects
for all
to authenticated
using (false)
with check (false);
