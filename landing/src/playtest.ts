import { initShared, onReady } from './shared'
import './styles/playtest.css'

/** A build-time URL is only used if it parses and uses an allowed scheme, so a typo'd
 *  or hostile value can never become a clickable link. */
function safeUrl(value: string | undefined, schemes: readonly string[]): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return schemes.includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

function initDownload(): void {
  const href = safeUrl(import.meta.env.PUBLIC_DOWNLOAD_URL, ['https:'])
  const link = document.querySelector<HTMLAnchorElement>('[data-download]')
  const fallback = document.querySelector<HTMLElement>('[data-download-fallback]')
  if (link && href) {
    link.href = href
    link.hidden = false
    if (fallback) fallback.hidden = true
  }

  const label = import.meta.env.PUBLIC_BUILD_LABEL
  const labelEl = document.querySelector<HTMLElement>('[data-build-label]')
  if (labelEl && label) {
    labelEl.textContent = label
    labelEl.hidden = false
  }
}

function initFeedback(): void {
  const href = safeUrl(import.meta.env.PUBLIC_FEEDBACK_URL, ['https:', 'mailto:'])
  const link = document.querySelector<HTMLAnchorElement>('[data-feedback]')
  const fallback = document.querySelector<HTMLElement>('[data-feedback-fallback]')
  if (!link || !href) return
  link.href = href
  link.hidden = false
  if (fallback) fallback.hidden = true
}

/** The things-to-try list remembers its ticks on this device. Storage is a nicety:
 *  if it is unavailable the list still works for the visit. */
function initChecklist(): void {
  const list = document.querySelector<HTMLElement>('[data-checklist]')
  if (!list) return
  const key = list.dataset.checklist ?? 'mosh-playtest-checklist'
  const boxes = Array.from(list.querySelectorAll<HTMLInputElement>('input[data-check]'))
  const count = document.querySelector<HTMLElement>('[data-checklist-count]')

  let saved: string[] = []
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (Array.isArray(raw)) saved = raw.filter((v): v is string => typeof v === 'string')
  } catch {
    saved = []
  }
  for (const box of boxes) box.checked = saved.includes(box.dataset.check ?? '')

  const render = (): void => {
    const done = boxes.filter((b) => b.checked).length
    if (count) count.textContent = `${done} of ${boxes.length} tried`
  }
  render()

  list.addEventListener('change', () => {
    render()
    const done = boxes.filter((b) => b.checked)
    try {
      localStorage.setItem(key, JSON.stringify(done.map((b) => b.dataset.check)))
    } catch {
      // not persisted this time
    }
  })
}

/** Highlights the step being read in the sticky list. */
function initToc(): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('.toc__list a'))
  if (links.length === 0 || !('IntersectionObserver' in window)) return
  const byId = new Map(links.map((a) => [a.getAttribute('href')?.slice(1) ?? '', a]))
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        for (const a of links) a.removeAttribute('aria-current')
        byId.get(entry.target.id)?.setAttribute('aria-current', 'true')
      }
    },
    { rootMargin: '-25% 0px -65% 0px' },
  )
  for (const id of byId.keys()) {
    const el = document.getElementById(id)
    if (el) observer.observe(el)
  }
}

onReady(() => {
  initShared()
  initDownload()
  initFeedback()
  initChecklist()
  initToc()
})
