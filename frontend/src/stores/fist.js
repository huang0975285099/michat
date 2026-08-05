import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fistApi } from 'src/services/api'

export const useFistStore = defineStore('fist', () => {
  const balance = ref(0)
  const totalEarned = ref(0)
  const todayWins = ref(0)
  const todayMax = ref(10)
  const todayEarned = ref(0)
  const transactions = ref([])
  const txHasMore = ref(true)

  async function fetchAccount() {
    try {
      const { data } = await fistApi.getAccount()
      balance.value = data.balance
      totalEarned.value = data.total_earned
      todayWins.value = data.today_wins
      todayMax.value = data.today_max
      todayEarned.value = data.today_earned
    } catch {
      // Fail silently, without blocking the game
    }
  }

  // Paging loading flow, reset=true to load from scratch
  async function fetchTransactions(reset = false) {
    if (!reset && !txHasMore.value) return
    const beforeId = reset ? undefined : transactions.value.at(-1)?.id
    try {
      const { data } = await fistApi.getTransactions(beforeId)
      const list = data.transactions ?? []
      transactions.value = reset ? list : [...transactions.value, ...list]
      txHasMore.value = list.length === 20
    } catch {
      // Silently fails
    }
  }

  return {
    balance, totalEarned, todayWins, todayMax, todayEarned,
    transactions, txHasMore,
    fetchAccount, fetchTransactions,
  }
})
