# Deploying the Mosh landing page

`landing/` is a fully standalone static site (Vite + vanilla TypeScript, no framework)
with its own `package.json` — it does not import from `ui/` or anywhere else in the
monorepo, and it builds independently of the native app. Build once, host the output
directory anywhere that serves static files.

## Build

```sh
cd landing
npm install
npm run build
# → landing/dist/  (static HTML/CSS/JS, hashed filenames, ready to upload as-is)
```

`npm run build` runs `tsc --noEmit` first, so a type error fails the build before Vite
even starts bundling.

## Environment variables

Set these in the **host's** environment/project settings (Vercel / Cloudflare Pages),
not in a file you commit. They're read at **build time** and baked into the shipped JS
— this is a static site with no server, so only ever put values here that are safe to
ship to every visitor's browser (the same posture `supabase/README.md` documents for
the multiplayer relay's publishable key).

| Variable | Required | What it's for |
| --- | --- | --- |
| `PUBLIC_SUPABASE_URL` | yes, unless using `PUBLIC_WAITLIST_URL` | Your Supabase project URL, e.g. `https://xxxx.supabase.co` |
| `PUBLIC_SUPABASE_ANON_KEY` | yes, unless using `PUBLIC_WAITLIST_URL` | The project's **anon/publishable** key. Never the `service_role` key — that must never reach a browser. |
| `PUBLIC_WAITLIST_URL` | no | Overrides the default Supabase table insert. If set, the form POSTs `{ "email": "...", "source": "..." }` as JSON to this URL instead — a custom Edge Function, a webhook, a different backend entirely. Contract: respond 2xx for a new signup, `409` for an address already on the list, anything else is treated as an error. |
| `PUBLIC_WAITLIST_SOURCE` | no | Short label stored in the `source` column (default `"landing"`). Useful if a second landing page/campaign ever exists and you want to tell signups apart. |

Copy `.env.example` to `.env.local` for local dev (gitignored); set the same names in
the host's dashboard for production. Without either `PUBLIC_WAITLIST_URL` or the two
Supabase variables set, the form fails closed with a clear on-page message ("signups
aren't wired up on this build yet") and a console warning — it never fails silently.

## One-time: create the `waitlist` table

This repo does **not** apply the migration for you. Before signups can land anywhere,
apply `supabase/migrations/20260717214247_waitlist.sql` to whichever Supabase project
`PUBLIC_SUPABASE_URL` points at. Two reasonable choices:

- **Reuse the existing Mosh Supabase project** (the one `supabase/README.md`
  documents for the multiplayer relay) — one project for the whole app, less to
  administer.
- **Stand up a separate project** just for the marketing site — keeps a public,
  internet-facing insert endpoint fully isolated from the multiplayer relay's
  operational data. A reasonable call if that separation matters to you.

Either way:

```sh
supabase link --project-ref <your-ref>
supabase db push          # applies any not-yet-applied migrations/*.sql
```

or paste the file's contents into the project's SQL Editor in the dashboard. Reading
the signups back out is deliberately not exposed over the API (see the migration's
comments) — use the Table Editor in the dashboard, or query with the `service_role`
key from a trusted place, when it's time to send invites.

## Vercel

1. **New Project** → import this repo.
2. **Root Directory:** `landing`
3. **Framework Preset:** Vite (or "Other" — the settings below work either way)
4. **Build Command:** `npm run build`
5. **Output Directory:** `dist`
6. **Install Command:** `npm install`
7. Add the environment variables from the table above under **Project Settings →
   Environment Variables** (Production, and Preview if you want preview deploys to
   hit a real or staging table).
8. Deploy. Add your domain under **Project Settings → Domains**, then point its DNS
   (Vercel will show you the exact A/ALIAS or CNAME record for that domain) at Vercel.

CLI equivalent:

```sh
cd landing
vercel link
vercel env add PUBLIC_SUPABASE_URL production
vercel env add PUBLIC_SUPABASE_ANON_KEY production
vercel --prod
```

## Cloudflare Pages

1. **Workers & Pages → Create → Pages → Connect to Git** → this repo.
2. **Root directory:** `landing`
3. **Build command:** `npm run build`
4. **Build output directory:** `dist`
5. **Settings → Environment variables** → add the table above for Production (and
   Preview if desired).
6. Deploy. Add your domain under **Custom domains** → follow Cloudflare's CNAME (or
   nameserver) instructions for that domain.

CLI equivalent (Wrangler):

```sh
cd landing
npm run build
npx wrangler pages deploy dist --project-name=mosh-landing
```

## Notes

- The site is 100% static after build — no server, no API routes, no SSR. The
  waitlist form talks directly to Supabase's PostgREST API (or your
  `PUBLIC_WAITLIST_URL`) from the visitor's browser.
- `PUBLIC_*` variables are inlined into the shipped JS at build time — anyone can read
  them in devtools. That's expected and safe for the anon key; never put a
  `service_role` key or anything secret behind a `PUBLIC_` name.
- Redeploy (rebuild) any time a `PUBLIC_*` value changes — a static build doesn't pick
  up environment changes at runtime.
- Fonts (`@fontsource-variable/bricolage-grotesque`, `@fontsource/ibm-plex-mono`) are
  self-hosted npm packages bundled at build time — no Google Fonts or other
  third-party request at runtime, and nothing to configure for that.
