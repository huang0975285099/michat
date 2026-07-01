import { ref, computed } from 'vue'

const LS_REGION_KEY = 'ironfist_region'

// 模块级单例：所有组件共享同一个响应式 region，切换后全局同步
const region = ref(localStorage.getItem(LS_REGION_KEY) || '')
const currency = computed(() => region.value === 'cn' ? '积分' : '$FIST')

export function useRegion() {
    function setRegion(r) {
        try { localStorage.setItem(LS_REGION_KEY, r) } catch {}
        region.value = r
    }
    return { region, currency, setRegion }
}
