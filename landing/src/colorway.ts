// The app's four colorways, on the site. The *initial* colorway is stamped onto
// <html data-colorway> by the inline bootstrap in each page's <head>; this module wires
// the picker and swaps every screenshot to the matching capture. STORAGE_KEY must stay
// in sync with the literal in that inline script.
const STORAGE_KEY = 'mosh-landing-colorway'

export const COLORWAYS = ['lime', 'bone', 'violet', 'coral'] as const
export type Colorway = (typeof COLORWAYS)[number]

function isColorway(value: string | null | undefined): value is Colorway {
  return (COLORWAYS as readonly string[]).includes(value ?? '')
}

export function currentColorway(): Colorway {
  const stamped = document.documentElement.getAttribute('data-colorway')
  return isColorway(stamped) ? stamped : 'lime'
}

const shotUrl = (colorway: Colorway): string => `/img/mosh-shell-${colorway}.webp`

function applyShots(colorway: Colorway): void {
  const url = shotUrl(colorway)
  for (const img of document.querySelectorAll<HTMLImageElement>('img[data-shot]')) {
    if (!img.src.endsWith(url)) img.src = url
  }
}

function syncButtons(colorway: Colorway): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-colorway-set]')) {
    button.setAttribute('aria-pressed', String(button.dataset.colorwaySet === colorway))
  }
}

export function initColorway(): void {
  const initial = currentColorway()
  if (initial !== 'lime') applyShots(initial)
  syncButtons(initial)

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-colorway-set]')) {
    const target = button.dataset.colorwaySet
    if (!isColorway(target)) continue
    // Warm the capture on intent so the swap is instant.
    button.addEventListener('pointerenter', () => { new Image().src = shotUrl(target) }, { once: true })
    button.addEventListener('click', () => {
      document.documentElement.setAttribute('data-colorway', target)
      applyShots(target)
      syncButtons(target)
      try {
        localStorage.setItem(STORAGE_KEY, target)
      } catch {
        // Storage can be unavailable (private browsing); the choice still holds for this visit.
      }
    })
  }
}
