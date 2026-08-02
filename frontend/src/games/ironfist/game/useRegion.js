import { ref, computed } from 'vue'

// 当前仅开放中国版，游戏内资产统一展示为“积分”。
const region = ref('cn')
const currency = computed(() => '积分')

// 国际版地区切换暂时停用。保留原实现注释，后续重新开放时可恢复。
// const LS_REGION_KEY = 'ironfist_region'
// const region = ref(localStorage.getItem(LS_REGION_KEY) || '')
// const currency = computed(() => region.value === 'cn' ? '积分' : '$FIST')

export function useRegion() {
    // function setRegion(r) {
    //     try { localStorage.setItem(LS_REGION_KEY, r) } catch {}
    //     region.value = r
    // }
    return { region, currency }
}
