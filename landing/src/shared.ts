// What every page does: fonts, base styles, theme and colorway, live splats, reveals.
import '@fontsource-variable/archivo/wdth.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/motion.css'

import { initThemeToggle } from './theme'
import { initColorway } from './colorway'
import { initScrollReveal } from './reveal'
import { initPoke, initSplats } from './splat'

export function initShared(): void {
  const themeToggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]')
  if (themeToggle) initThemeToggle(themeToggle)

  initColorway()
  initSplats()
  initPoke()
  initScrollReveal()

  const yearEl = document.querySelector<HTMLElement>('[data-year]')
  if (yearEl) yearEl.textContent = String(new Date().getFullYear())
}

export function onReady(init: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
}
