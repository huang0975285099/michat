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
      { path: 'games', component: () => import('src/pages/GamesPage.vue') },
      { path: 'games/ironfist', component: () => import('src/games/ironfist/IronFistPage.vue') },
      { path: 'games/sugar-pop', component: () => import('src/games/sugar-pop/SugarPopPage.vue') },
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

// load() is only called once: when the app starts
let loaded = false
router.beforeEach(async (to) => {
  if (!loaded) {
    const store = useIdentityStore()
    await store.load()
    loaded = true
  }
  // init page does not require authentication
  if (to.path === '/init') return true
  // The homepage is always accessible, the isReady status is read by the page itself
  if (to.path === '/') return true
  const store = useIdentityStore()
  if (!store.isReady) return '/init'
  return true
})

export default router
