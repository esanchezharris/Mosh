// The Moshi dock on the home page: a REPLAY, not an agent. The dock rests on a real reply
// (it is in the markup, so it is never empty); clicking an ask types it into the field,
// the creature thinks, and the reply line shows what Moshi answered to that same ask in
// the showcase session. Asks and replies live in the markup (data-ask /
// data-reply) so the copy stays reviewable in one place.
import { getSplat } from './splat'

const TYPE_MS = 34
const THINK_MS = 950

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

export function initMoshiDemo(): void {
  const root = document.querySelector<HTMLElement>('[data-moshi-demo]')
  if (!root) return
  const say = root.querySelector<HTMLElement>('[data-moshi-say]')
  const field = root.querySelector<HTMLElement>('[data-moshi-field]')
  const asks = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-ask]'))
  if (!say || !field || asks.length === 0) return

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  let running = false

  async function run(button: HTMLButtonElement): Promise<void> {
    if (running) return
    running = true
    const ask = button.dataset.ask ?? ''
    const reply = button.dataset.reply ?? ''
    const splat = getSplat('dock')
    for (const b of asks) {
      b.disabled = true
      b.setAttribute('aria-pressed', String(b === button))
    }

    if (reduced) {
      field!.textContent = ''
      say!.textContent = reply
    } else {
      say!.dataset.pending = 'true'
      field!.textContent = ''
      for (const ch of ask) {
        field!.textContent += ch
        await wait(TYPE_MS)
      }
      await wait(220)
      field!.textContent = ''
      splat?.setState('thinking')
      await wait(THINK_MS)
      say!.textContent = reply
      delete say!.dataset.pending
      splat?.setState('idle')
      splat?.flash('laugh', 1.2)
    }

    for (const b of asks) b.disabled = false
    running = false
  }

  for (const button of asks) button.addEventListener('click', () => void run(button))
}
