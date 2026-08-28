import { defineConfig } from '#q-app/wrappers'
import { readFileSync } from 'node:fs'

// Read the version number of package.json and inject it into the application during construction for display on the "Me" page
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig(() => {
  return {
    boot: ['pinia', 'i18n', 'chat-service'],

    css: ['app.scss'],

    extras: ['material-icons'],

    build: {
      env: {
        APP_VERSION: pkg.version,
        BUILD_TIME: new Date().toISOString()
      },
      target: {
        browser: ['es2017', 'chrome66', 'safari11', 'firefox60'],
        node: 'node20'
      },
      vueRouterMode: 'hash',
      vitePlugins: [],
      extendViteConf(viteConf) {
        viteConf.esbuild = viteConf.esbuild || {}
        viteConf.esbuild.target = 'es2017'
      }
    },

    devServer: {
      open: false,
      port: 9999,
      proxy: {
        '/api': {
          target: 'http://localhost:8888',
          changeOrigin: true
        },
        '/ws': {
          target: 'ws://localhost:8888',
          ws: true,
          changeOrigin: true
        }
      }
    },

    framework: {
      config: {},
      plugins: ['Notify', 'Dialog', 'Loading']
    },

    animations: [],

    ssr: { pwa: false },
    pwa: {
      workboxMode: 'GenerateSW',
      // After the new Service Worker is installed, it will take over and clean up the old cache immediately, and cooperate with the refresh prompt of register-service-worker.
      // Ensure that users can update to the latest version without manual flashing after release
      extendGenerateSWOptions(cfg) {
        cfg.skipWaiting = true
        cfg.clientsClaim = true
        cfg.cleanupOutdatedCaches = true
        // Paths served by the backend rather than by this SPA bundle. Without an
        // entry here the navigation fallback answers them from the precached
        // index.html, so the request never reaches nginx and the chat app is
        // rendered instead — no matter how the proxy is configured.
        cfg.navigateFallbackDenylist = [
          ...(cfg.navigateFallbackDenylist || []),
          /^\/download(?:\/|$)/,
          /^\/admin(?:\/|$)/
        ]
      },
      manifest: {
        name: 'Yunmi',
        short_name: 'yunChat',
        description: 'End-to-end encrypted chat',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#1976D2',
        icons: [
          { src: 'icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512x512.png', sizes: '512x512', type: 'image/png' }
        ]
      }
    },
    cordova: {},
    capacitor: {
      hideSplashscreen: true,
      iosStatusBarPadding: true
    },
    electron: {
      bundler: 'builder',
      builder: {
        appId: 'com.yzs88.e2eechat',
        productName: 'Yunmi',
        win: {
          target: [{ target: 'nsis', arch: ['x64'] }],
          icon: 'src-electron/icons/icon.ico'
        },
        nsis: {
          oneClick: false,
          allowToChangeInstallationDirectory: true,
          installerLanguages: ['zh_CN'],
          language: '2052'
        }
      }
    },
    bex: {}
  }
})
