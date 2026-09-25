// Same font + design tokens as the other renderers, so the launcher and
// browser read as part of the app rather than a separate tool.
import '../assets/main.css'
import { loadProprietaryFonts } from '../assets/proprietaryFonts'

import { createApp } from 'vue'
import AppsOverlayApp from './AppsOverlayApp.vue'

document.documentElement.setAttribute('data-theme', 'dark')

// No vue-i18n: main pushes the localized copy with every show.
loadProprietaryFonts()

createApp(AppsOverlayApp).mount('#app')
