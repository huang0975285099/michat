<template>
    <div class="q-pa-md sub-view">
        <div class="row items-center q-mb-md">
            <q-btn
                flat
                round
                dense
                icon="arrow_back"
                color="white"
                @click="$emit('back')"
            />
            <div class="text-h6 q-ml-sm">{{ t("ironFist.achievementTitle") }}</div>
        </div>

        <div v-if="loading && !stats" class="text-center q-py-xl">
            <q-spinner-dots color="amber-8" size="38px" />
        </div>
        <template v-else-if="stats">
            <div class="ach-grid">
                <div
                    v-for="a in localizedAchievements"
                    :key="a.code"
                    class="ach-item"
                    :class="{ 'ach-item--locked': !unlockedSet.has(a.code) }"
                >
                    <div class="ach-icon">
                        {{ unlockedSet.has(a.code) ? a.icon : "🔒" }}
                    </div>
                    <div class="ach-info">
                        <div class="ach-name">{{ a.name }}</div>
                        <div class="ach-desc">{{ a.desc }}</div>
                    </div>
                    <q-icon
                        v-if="unlockedSet.has(a.code)"
                        name="check_circle"
                        color="amber-8"
                        size="20px"
                    />
                </div>
            </div>
            <div class="text-caption text-grey-6 q-mt-md text-center">
                {{ t("ironFist.achievementProgress", { unlocked: stats.achievements.length, total: ACHIEVEMENTS.length }) }}
            </div>
        </template>
    </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { Notify } from "quasar";
import { ironfistApi } from "src/services/api";
import { ACHIEVEMENTS } from "../game/ironfistMeta";
import { useI18n } from "src/i18n";

defineEmits(["back"]);
const { t } = useI18n();
const achievementKeys = {
    first_battle: ["achievementFirstName", "achievementFirstDesc"],
    hundred_battles: ["achievementHundredName", "achievementHundredDesc"],
    win_streak_5: ["achievementStreakName", "achievementStreakDesc"],
    counter_master: ["achievementCounterName", "achievementCounterDesc"],
    low_hp_comeback: ["achievementComebackName", "achievementComebackDesc"],
    high_hp_win: ["achievementHighHpName", "achievementHighHpDesc"],
};
const localizedAchievements = computed(() => ACHIEVEMENTS.map((achievement) => {
    const [nameKey, descKey] = achievementKeys[achievement.code];
    return { ...achievement, name: t(`ironFist.${nameKey}`), desc: t(`ironFist.${descKey}`) };
}));

const stats = ref(null);
const loading = ref(false);
const unlockedSet = computed(() => new Set(stats.value?.achievements ?? []));

onMounted(async () => {
    loading.value = true;
    try {
        const { data } = await ironfistApi.getStats();
        stats.value = data;
    } catch {
        Notify.create({
            message: t("ironFist.loadAchievementsFailed"),
            color: "negative",
            textColor: "white",
            position: "top",
            timeout: 1600,
        });
    } finally {
        loading.value = false;
    }
});
</script>

<style scoped>
.sub-view {
    min-height: 100dvh;
}
.ach-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.ach-item {
    display: flex;
    align-items: center;
    gap: 10px;
    background: rgba(255, 213, 79, 0.1);
    border: 1px solid rgba(255, 213, 79, 0.3);
    border-radius: 12px;
    padding: 10px 12px;
}
.ach-item--locked {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.08);
    opacity: 0.65;
}
.ach-icon {
    font-size: 26px;
    width: 36px;
    text-align: center;
    flex-shrink: 0;
}
.ach-info {
    flex: 1;
    min-width: 0;
}
.ach-name {
    font-weight: 700;
    font-size: 14px;
}
.ach-desc {
    font-size: 11px;
    color: #9e9e9e;
    margin-top: 1px;
}
</style>
