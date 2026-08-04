import { ref, computed } from 'vue'

// Currently, only the Chinese version is open, and in-game assets are displayed as “points”.
const region = ref('cn')
const currency = computed(() => 'Points')

// The international version region switching is temporarily disabled. The original implementation comments are retained and can be restored when reopened later.
// const LS_REGION_KEY = 'ironfist_region'
// const region = ref(localStorage.getItem(LS_REGION_KEY) || '')
// const currency = computed(() => region.value === 'cn' ? 'Points' : '$FIST')

export function useRegion() {
    // function setRegion(r) {
    //     try { localStorage.setItem(LS_REGION_KEY, r) } catch {}
    //     region.value = r
    // }
    return { region, currency }
}
