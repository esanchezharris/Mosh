# Deploying the Mosh site

Two pages: the site itself (`/`) and the playtest guide you send to friends
(`/playtest/`, marked `noindex`). The look follows the app's V3 shell: its palette
(`ui/src/v3/tokens.css`), its four colorways, and the same splat engine the dock draws.

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
| `PUBLIC_DOWNLOAD_URL` | no | Where the playtest page's **Download** button points: the signed, notarized DMG or zip, hosted wherever you like (`https` only). Unset, the page tells the tester to ask their host for the build. |
| `PUBLIC_BUILD_LABEL` | no | Short label beside the Download button, e.g. `Build 2026-10-02`. |
| `PUBLIC_FEEDBACK_URL` | no | Where playtest feedback goes: an `https` link (Discord, a form) or a `mailto:` address. Unset, the page says to message whoever invited them. |
| `PUBLIC_SITE_URL` | no | The site's public origin, e.g. `https://mosh.example`. Build-time only: makes the link-preview image URL absolute, which iMessage/Discord/Slack previews need. |

The waitlist block on the home page only renders when a waitlist backend is configured
(`PUBLIC_WAITLIST_URL`, or both Supabase variables). With none set the site is a pure
brochure plus the playtest guide, and no form appears.

Copy `.env.example` to `.env.local` for local dev (gitignored); set the same names in
the host's dashboard for production. Without either `PUBLIC_WAITLIST_URL` or the two
Supabase variables set, the waitlist block stays hidden.

## One-time, only if you want the waitlist: create the `waitlist` table

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

## Cloudflare (production: moshapp.net)

The site deploys to Cloudflare as a Worker with static assets, configured in
`wrangler.jsonc`: no Worker script, `dist/` served as-is, and `moshapp.net` plus
`www.moshapp.net` attached as custom domains (Cloudflare creates their DNS records and
certificates on deploy, because the zone lives in the same account).

One-time, on the machine that deploys:

```sh
wrangler login        # opens the browser; approve with the account that owns moshapp.net
```

Every deploy:

```sh
cd landing
npm run deploy        # = npm run build && wrangler deploy
```

Build-time values:

- `.env.production` (committed) sets `PUBLIC_SITE_URL=https://moshapp.net`.
- Put the per-round values in `.env.production.local` (gitignored), then redeploy:

  ```sh
  PUBLIC_DOWNLOAD_URL=https://…/Mosh.dmg
  PUBLIC_BUILD_LABEL=Build 2026-10-02
  PUBLIC_FEEDBACK_URL=mailto:you@example.com
  ```

`public/404.html` is the not-found page; it is self-contained on purpose (no hashed
bundle) because it is served for any missing path.

The build itself can be large to host: Workers assets cap a single file at 25 MiB, so
the app download does not go in `public/`. Host the DMG elsewhere (an R2 bucket with a
public domain works well on the same account) and point `PUBLIC_DOWNLOAD_URL` at it.

## Notes

- The site is 100% static after build — no server, no API routes, no SSR. The
  waitlist form talks directly to Supabase's PostgREST API (or your
  `PUBLIC_WAITLIST_URL`) from the visitor's browser.
- `PUBLIC_*` variables are inlined into the shipped JS at build time — anyone can read
  them in devtools. That's expected and safe for the anon key; never put a
  `service_role` key or anything secret behind a `PUBLIC_` name.
- Redeploy (rebuild) any time a `PUBLIC_*` value changes — a static build doesn't pick
  up environment changes at runtime.
- Fonts (`@fontsource-variable/archivo`, `@fontsource/ibm-plex-mono`) are
  self-hosted npm packages bundled at build time — no Google Fonts or other
  third-party request at runtime, and nothing to configure for that.

## Refreshing the product imagery

- **Screenshots** (`public/img/mosh-shell-<colorway>.webp`, 3024x1634): the four colorway
  captures of the V3 shell on the showcase session, produced by
  `ui/e2e/portfolio-shot.spec.ts` (`MOSH_PORTFOLIO_SHOT=1
  MOSH_PORTFOLIO_COLORWAYS=lime,bone,violet,coral`), then `cwebp -q 92`. Every feature crop
  on the home page is a window onto that same frame (`.crop` in `components.css`): rectangles
  in source pixels, all shown at one fixed zoom so the app's type is the same size in each.
  If the shell's layout moves, re-check the `--cx/--cy/--cw/--ch` values in `index.html`
  against the new capture: cut on panel and lane edges, and keep the playhead away from a
  crop's edge.
- **Icons** (`public/icon-64.png`, `icon-128.png`, `icon-256.png`, `apple-touch-icon.png`)
  are the Mac app icon, `resources/icon/MoshIcon.png`, cropped to its squircle
  (`sips -c 824 824`, then `sips -Z <size>`). Regenerate them if the app icon changes.
- **The splat** (`src/vendor/agent-sprites/engine.js`) is a copy of the app's
  `ui/src/vendor/agent-sprites/engine.js`. Copy it again when the app's changes.
- **Playtest copy** (`playtest/index.html`) names real controls (`+ Drum beat`, `Invite`,
  `Create session`, `Buffer`, `History`). Re-check it against the shell before each round.
