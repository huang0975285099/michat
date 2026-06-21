import { defineConfig } from '#q-app/wrappers'

export default defineConfig(() => {
  return {
    boot: ['pinia', 'chat-service'],

    css: ['app.scss'],

    extras: ['material-icons'],

    build: {
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
      manifest: {
        name: '云密',
        short_name: 'yunChat',
        description: '端对端加密聊天',
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
        productName: '云密',
        win: {
          target: [{ target: 'nsis', arch: ['x64'] }],
          icon: 'src-electron/icons/icon.ico'
        },
        mac: {
          target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
          icon: 'src-electron/icons/icon.icns'
        },
        linux: {
          target: [{ target: 'AppImage', arch: ['x64'] }],
          icon: 'src-electron/icons/icon.png'
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
