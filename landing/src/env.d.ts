/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Overrides the default Supabase table insert. If set, the waitlist form
   *  POSTs JSON `{ email, source }` here instead. Optional. */
  readonly PUBLIC_WAITLIST_URL?: string
  /** Supabase project URL, e.g. https://xxxx.supabase.co. Required unless
   *  PUBLIC_WAITLIST_URL is set. */
  readonly PUBLIC_SUPABASE_URL?: string
  /** Supabase project anon/publishable key — safe to ship to the browser.
   *  Required unless PUBLIC_WAITLIST_URL is set. NEVER the service_role key. */
  readonly PUBLIC_SUPABASE_ANON_KEY?: string
  /** Short label stored in the waitlist row's `source` column. Optional,
   *  defaults to "landing". */
  readonly PUBLIC_WAITLIST_SOURCE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
