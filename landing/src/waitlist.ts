// Email capture. Default target is a direct PostgREST insert into the
// `waitlist` table (see supabase/migrations/*_waitlist.sql — RLS is
// insert-only, so the anon key can add a row but can never read the list
// back). Set PUBLIC_WAITLIST_URL to POST to a different endpoint instead
// (a custom Edge Function, a webhook, anything) — same JSON contract either
// way: POST { email, source }, respond 2xx for a new signup, 409 for an
// address that's already on the list, anything else is an error.

interface SubmitResult {
  ok: boolean
  message: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_FILL_MS = 1200
const pageLoadedAt = Date.now()

function isValidEmail(value: string): boolean {
  return value.length > 0 && value.length <= 320 && EMAIL_RE.test(value)
}

async function submitToEndpoint(email: string, source: string): Promise<SubmitResult> {
  const customUrl = import.meta.env.PUBLIC_WAITLIST_URL

  if (customUrl) {
    const res = await fetch(customUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, source }),
    })
    if (res.ok) return { ok: true, message: "You're on the list — we'll email you." }
    if (res.status === 409) return { ok: true, message: "You're already on the list." }
    return { ok: false, message: 'Something went wrong. Try again in a moment.' }
  }

  const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !anonKey) {
    console.warn(
      '[mosh-landing] Waitlist is not configured: set PUBLIC_SUPABASE_URL + ' +
        'PUBLIC_SUPABASE_ANON_KEY, or PUBLIC_WAITLIST_URL. See landing/.env.example.',
    )
    return { ok: false, message: "Signups aren't wired up on this build yet." }
  }

  const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/waitlist`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify({ email, source }),
  })

  if (res.status === 201 || res.status === 200) {
    return { ok: true, message: "You're on the list — we'll email you when it's your turn." }
  }
  if (res.status === 409) {
    return { ok: true, message: "You're already on the list." }
  }
  return { ok: false, message: 'Something went wrong. Try again in a moment.' }
}

function showStatus(el: HTMLElement, state: 'success' | 'error' | null, message: string): void {
  el.textContent = message
  if (state) el.dataset.state = state
  else delete el.dataset.state
}

function initForm(form: HTMLFormElement, source: string): void {
  const emailInput = form.querySelector<HTMLInputElement>('[data-waitlist-email]')
  const trapInput = form.querySelector<HTMLInputElement>('[data-waitlist-trap]')
  const submitBtn = form.querySelector<HTMLButtonElement>('[data-waitlist-submit]')
  const status = form.querySelector<HTMLElement>('[data-waitlist-status]')
  if (!emailInput || !submitBtn || !status) return

  const idleLabel = submitBtn.textContent ?? 'Join the waitlist'

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void handleSubmit()
  })

  async function handleSubmit(): Promise<void> {
    const email = emailInput!.value.trim()

    // Two cheap, best-effort bot deterrents (the real backstop is RLS on the
    // table itself, which limits any abuse to junk rows, not data exposure):
    // a hidden honeypot field real users never see or fill, and a minimum
    // dwell time before the first legitimate submit is plausible.
    if (trapInput && trapInput.value.trim() !== '') {
      showStatus(status!, 'success', "You're on the list.")
      form.reset()
      return
    }
    if (Date.now() - pageLoadedAt < MIN_FILL_MS) {
      showStatus(status!, 'success', "You're on the list.")
      form.reset()
      return
    }

    if (!isValidEmail(email)) {
      showStatus(status!, 'error', "That email address doesn't look right.")
      emailInput!.focus()
      return
    }

    submitBtn!.disabled = true
    submitBtn!.textContent = 'Joining…'
    showStatus(status!, null, '')

    try {
      const result = await submitToEndpoint(email, source)
      showStatus(status!, result.ok ? 'success' : 'error', result.message)
      if (result.ok) form.reset()
    } catch (err) {
      console.error('[mosh-landing] waitlist submit failed', err)
      showStatus(status!, 'error', 'Network error — check your connection and try again.')
    } finally {
      submitBtn!.disabled = false
      submitBtn!.textContent = idleLabel
    }
  }
}

export function initWaitlistForms(): void {
  const source = import.meta.env.PUBLIC_WAITLIST_SOURCE || 'landing'
  const forms = document.querySelectorAll<HTMLFormElement>('[data-waitlist-form]')
  for (const form of forms) initForm(form, source)
}
