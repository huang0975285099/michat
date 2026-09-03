<template>
    <q-page class="q-pa-md">
        <!-- <div class="text-h6 text-grey-7 q-mb-md">Game Center</div> -->

        <div class="row q-col-gutter-md">
            <!-- iron fist -->
            <div class="col-6 col-sm-4 col-md-3">
                <q-card class="game-card cursor-pointer" @click="router.push('/games/ironfist')">
                    <q-card-section class="text-center q-pa-lg">
                        <div style="font-size: 52px">🥊</div>
                        <div class="text-subtitle1 text-bold q-mt-sm">{{ t("games.ironFist") }}</div>
                        <div class="text-caption text-grey-6">{{ t("games.ironFistDesc") }}</div>
                    </q-card-section>
                    <q-separator />
                    <q-card-actions align="center" class="q-py-sm">
                        <q-chip dense color="positive" text-color="white" icon="people" label="1v1" />
                        <q-chip dense color="purple" text-color="white" icon="psychology" :label="t('games.strategy')" />
                    </q-card-actions>
                </q-card>
            </div>
        </div>
    </q-page>
</template>

<script setup>
import { useRouter } from 'vue-router'
import { useI18n } from 'src/i18n'

defineOptions({ name: 'GamesPage' })
const router = useRouter()
const { t } = useI18n()
</script>

<style scoped>
.game-card {
    border-radius: 16px;
    transition: transform 0.15s, box-shadow 0.15s;
}
.game-card:hover {
    transform: translateY(-3px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
}
</style>
