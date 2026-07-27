import '@fontsource-variable/bricolage-grotesque'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/sections.css'
import './styles/motion.css'

import { initThemeToggle } from './theme'
import { initScrollReveal } from './reveal'
import { initWaveform } from './waveform'
import { initWaitlistForms } from './waitlist'

function init(): void {
  const themeToggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]')
  if (themeToggle) initThemeToggle(themeToggle)

  const scope = document.querySelector<HTMLElement>('[data-scope]')
  if (scope) initWaveform(scope)

  initScrollReveal()
  initWaitlistForms()

  const yearEl = document.querySelector<HTMLElement>('[data-year]')
  if (yearEl) yearEl.textContent = String(new Date().getFullYear())
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
