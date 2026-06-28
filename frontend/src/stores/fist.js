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
      // 静默失败，不阻塞游戏
    }
  }

  // 返回 { todayWins, todayMax, balance } 供结果页展示，达限或出错返回 null
  async function claimPvEReward() {
    try {
      const { data } = await fistApi.claimPvEReward()
      balance.value = data.balance
      totalEarned.value = data.total_earned
      todayWins.value = data.today_wins
      todayMax.value = data.today_max
      todayEarned.value = data.today_earned
      return {
        todayWins: data.today_wins,
        todayMax: data.today_max,
        balance: data.balance,
        bonusAwarded: data.bonus_awarded,
        bonusAmount: data.bonus_amount,
      }
    } catch (e) {
      // 429 = 今日已达 10 次上限，静默忽略
      return null
    }
  }

  // 分页加载流水，reset=true 从头加载
  async function fetchTransactions(reset = false) {
    if (!reset && !txHasMore.value) return
    const beforeId = reset ? undefined : transactions.value.at(-1)?.id
    try {
      const { data } = await fistApi.getTransactions(beforeId)
      const list = data.transactions ?? []
      transactions.value = reset ? list : [...transactions.value, ...list]
      txHasMore.value = list.length === 20
    } catch {
      // 静默失败
    }
  }

  return {
    balance, totalEarned, todayWins, todayMax, todayEarned,
    transactions, txHasMore,
    fetchAccount, claimPvEReward, fetchTransactions,
  }
})
