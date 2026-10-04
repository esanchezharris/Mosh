import { initShared, onReady } from './shared'
import './styles/home.css'

import { initMoods } from './moods'
import { initMoshiDemo } from './moshiDemo'
import { initWaitlistForms, waitlistConfigured } from './waitlist'

onReady(() => {
  initShared()
  initMoshiDemo()
  initMoods()

  // The waitlist only appears on builds that have somewhere to send a signup.
  const waitlist = document.querySelector<HTMLElement>('[data-waitlist-block]')
  if (waitlist && waitlistConfigured()) {
    waitlist.hidden = false
    initWaitlistForms()
  }
})
