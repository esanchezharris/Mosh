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
  /** Where the playtest page's Download button points (https only): the notarized
   *  DMG or zip, hosted wherever you like. Unset: the page tells the tester to ask
   *  their host for the build. */
  readonly PUBLIC_DOWNLOAD_URL?: string
  /** Short label shown beside the Download button, e.g. "Build 2026-10-02". Optional. */
  readonly PUBLIC_BUILD_LABEL?: string
  /** Where playtest feedback goes: an https link (Discord, a form) or a mailto:
   *  address. Unset: the page tells the tester to message their host. */
  readonly PUBLIC_FEEDBACK_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
