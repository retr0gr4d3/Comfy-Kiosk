import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // node-pty is a native addon; it must stay external (its .node binary
        // can't be bundled) and is loaded from the unpacked node_modules.
        external: ['node-pty']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          comfyPreload: resolve(__dirname, 'src/preload/comfyPreload.ts'),
          terminalPreload: resolve(__dirname, 'src/preload/terminalPreload.ts'),
          comfyTitleBarPreload: resolve(__dirname, 'src/preload/comfyTitleBarPreload.ts'),
          comfyTitlePopupPreload: resolve(__dirname, 'src/preload/comfyTitlePopupPreload.ts'),
          comfyTitleTooltipPreload: resolve(__dirname, 'src/preload/comfyTitleTooltipPreload.ts'),
          comfySystemModalPreload: resolve(__dirname, 'src/preload/comfySystemModalPreload.ts'),
          systemTerminalPreload: resolve(__dirname, 'src/preload/systemTerminalPreload.ts'),
          appsOverlayPreload: resolve(__dirname, 'src/preload/appsOverlayPreload.ts')
        }
      }
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          panel: resolve(__dirname, 'src/renderer/panel.html'),
          comfyTitleBar: resolve(__dirname, 'src/renderer/comfyTitleBar.html'),
          comfyTitlePopup: resolve(__dirname, 'src/renderer/comfyTitlePopup.html'),
          comfyTitleTooltip: resolve(__dirname, 'src/renderer/comfyTitleTooltip.html'),
          comfySystemModal: resolve(__dirname, 'src/renderer/comfySystemModal.html'),
          systemTerminal: resolve(__dirname, 'src/renderer/systemTerminal.html'),
          appsOverlay: resolve(__dirname, 'src/renderer/appsOverlay.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@locales': resolve('locales')
      }
    },
    plugins: [vue(), tailwindcss()]
  }
})
