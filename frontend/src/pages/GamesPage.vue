<template>
    <q-page class="q-pa-md">
        <!-- <div class="text-h6 text-grey-7 q-mb-md">Game Center</div> -->

        <div class="row q-col-gutter-md">
            <!-- iron fist -->
            <div class="col-6 col-sm-4 col-md-3">
                <q-card class="game-card cursor-pointer" @click="router.push('/games/ironfist')">
                    <q-card-section class="text-center q-pa-lg">
                        <div style="font-size: 52px">🥊</div>
                        <div class="text-subtitle1 text-bold q-mt-sm">iron fist3D</div>
                        <div class="text-caption text-grey-6">Blockchain technology·Zero cheating·Open and transparent</div>
                    </q-card-section>
                    <q-separator />
                    <q-card-actions align="center" class="q-py-sm">
                        <q-chip dense color="positive" text-color="white" icon="people" label="1v1" />
                        <q-chip dense color="purple" text-color="white" icon="psychology" label="Strategy" />
                    </q-card-actions>
                </q-card>
            </div>

            <!-- sugar pop -->
            <div class="col-6 col-sm-4 col-md-3">
                <q-card class="game-card cursor-pointer" @click="router.push('/games/sugar-pop')">
                    <q-card-section class="text-center q-pa-lg">
                        <div style="font-size: 52px">🍬</div>
                        <div class="text-subtitle1 text-bold q-mt-sm">Sugar Pop</div>
                        <div class="text-caption text-grey-6">Sweet match-3 adventure</div>
                    </q-card-section>
                    <q-separator />
                    <q-card-actions align="center" class="q-py-sm">
                        <q-chip dense color="pink" text-color="white" icon="grid_view" label="Match-3" />
                        <q-chip dense color="teal" text-color="white" icon="wifi_off" label="Offline" />
                    </q-card-actions>
                </q-card>
            </div>
        </div>
    </q-page>
</template>

<script setup>
import { useRouter } from 'vue-router'

defineOptions({ name: 'GamesPage' })
const router = useRouter()
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
