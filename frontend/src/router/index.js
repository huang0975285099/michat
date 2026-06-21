import { createRouter, createWebHashHistory } from 'vue-router'
import { useIdentityStore } from 'src/stores/identity'

const routes = [
  {
    path: '/',
    component: () => import('src/layouts/MainLayout.vue'),
    children: [
      { path: '', component: () => import('src/pages/HomePage.vue') },
      { path: 'chats', component: () => import('src/pages/ChatsPage.vue') },
      { path: 'chat/:chatId', component: () => import('src/pages/ChatPage.vue') },
      { path: 'friends', component: () => import('src/pages/FriendsPage.vue') },
      { path: 'profile', component: () => import('src/pages/ProfilePage.vue') }
    ]
  },
  {
    path: '/init',
    component: () => import('src/pages/InitPage.vue')
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

// load() 只调用一次：应用启动时
let loaded = false
router.beforeEach(async (to) => {
  if (!loaded) {
    const store = useIdentityStore()
    await store.load()
    loaded = true
  }
  // init 页无需身份验证
  if (to.path === '/init') return true
  // 首页始终可访问，isReady 状态由页面自身读取
  if (to.path === '/') return true
  const store = useIdentityStore()
  if (!store.isReady) return '/init'
  return true
})

export default router
