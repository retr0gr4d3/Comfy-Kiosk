// Same font + design tokens as the other renderers, so the terminal reads as
// part of the app rather than a separate tool.
import '../assets/main.css'
import { loadProprietaryFonts } from '../assets/proprietaryFonts'

import { createApp } from 'vue'
import SystemTerminalApp from './SystemTerminalApp.vue'

document.documentElement.setAttribute('data-theme', 'dark')

// No vue-i18n: main pushes the localized header copy with every show.
loadProprietaryFonts()

createApp(SystemTerminalApp).mount('#app')
