import { ref, computed } from 'vue'
import { useI18n } from '../../../i18n/index.js'

// The game currently uses one points system; only its display name follows the app language.
const region = ref('cn')

// The international version region switching is temporarily disabled. The original implementation comments are retained and can be restored when reopened later.
// const LS_REGION_KEY = 'ironfist_region'
// const region = ref(localStorage.getItem(LS_REGION_KEY) || '')
// International token mode is intentionally disabled; current currency is always points.

export function useRegion() {
    const { locale } = useI18n()
    const currency = computed(() => locale.value === 'zh-CN' ? '积分' : 'Points')

    // function setRegion(r) {
    //     try { localStorage.setItem(LS_REGION_KEY, r) } catch {}
    //     region.value = r
    // }
    return { region, currency }
}
