<template>
    <q-dialog v-model="show" persistent>
        <q-card style="min-width: 290px; border-radius: 16px">
            <q-card-section class="text-center q-pt-lg q-pb-sm">
                <q-icon name="sports_esports" color="primary" size="52px" />
                <div class="text-h6 q-mt-sm">{{ gameTitle }}</div>
                <div class="text-subtitle2 text-grey-7 q-mt-xs">{{ displayName }}</div>
                <div class="text-caption text-grey-5">{{ t("call.inviteGame") }}</div>
            </q-card-section>
            <q-card-actions align="around" class="q-pb-lg q-px-xl">
                <div class="column items-center gap-xs">
                    <q-btn round color="negative" icon="close" size="lg"
                        @click="gameStore.rejectInvite()" />
                    <div class="text-caption text-grey-6 q-mt-xs">{{ t("common.reject") }}</div>
                </div>
                <div class="column items-center gap-xs">
                    <q-btn round color="primary" icon="sports_esports" size="lg"
                        @click="gameStore.acceptInvite()" />
                    <div class="text-caption text-grey-6 q-mt-xs">{{ t("common.accept") }}</div>
                </div>
            </q-card-actions>
        </q-card>
    </q-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { useGameStore } from 'src/stores/game'
import { useIdentityStore } from 'src/stores/identity'
import { useI18n } from 'src/i18n'

const gameStore = useGameStore()
const identity  = useIdentityStore()
const { t } = useI18n()

const show = computed(() => gameStore.state === 'invited')

const gameTitle = computed(() => gameStore.game === 'ironfist' ? t('call.ironFistBattle') : t('call.gameBattle'))

// Show nickname from cache if available, otherwise chatId
const displayName = computed(() =>
    identity.friendNames?.[gameStore.opponentId] || gameStore.opponentNickname
)
</script>
