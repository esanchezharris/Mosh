// "Moshi hangs around until you ask, goes wide-eyed while the mic is live, …": each
// phrase in that sentence is a control that puts the creature beside it in that mood.
// Hover and keyboard focus preview a mood; a click, tap, Enter or Space keeps it. The
// phrases are role="button" spans so they wrap like text, hence the key handling here.
import { getSplat } from './splat'

export function initMoods(): void {
  const root = document.querySelector<HTMLElement>('[data-moods]')
  const splat = getSplat('moods')
  if (!root || !splat) return
  const buttons = Array.from(root.querySelectorAll<HTMLElement>('[data-mood]'))

  let kept = buttons.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.mood ?? 'idle'
  const show = (mood: string): void => splat.setState(mood)
  const keep = (mood: string): void => {
    kept = mood
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.mood === mood))
    show(mood)
  }

  for (const button of buttons) {
    const mood = button.dataset.mood ?? 'idle'
    button.addEventListener('pointerenter', () => show(mood))
    button.addEventListener('focus', () => show(mood))
    button.addEventListener('pointerleave', () => show(kept))
    button.addEventListener('blur', () => show(kept))
    button.addEventListener('click', () => keep(mood))
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      keep(mood)
    })
  }
}
