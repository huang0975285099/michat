<template>
    <q-page class="q-pa-md">
        <div class="text-h6 text-grey-7 q-mb-md">游戏中心</div>

        <div class="row q-col-gutter-md">
            <!-- 炸弹人 -->
            <div class="col-6 col-sm-4 col-md-3">
                <q-card class="game-card cursor-pointer" @click="router.push('/games/bomberman')">
                    <q-card-section class="text-center q-pa-lg">
                        <div style="font-size: 52px">💣</div>
                        <div class="text-subtitle1 text-bold q-mt-sm">炸弹人</div>
                        <div class="text-caption text-grey-6">2人实时对战</div>
                    </q-card-section>
                    <q-separator />
                    <q-card-actions align="center" class="q-py-sm">
                        <q-chip dense color="positive" text-color="white" icon="people" label="1v1" />
                        <q-chip dense color="orange" text-color="white" icon="bolt" label="实时" />
                    </q-card-actions>
                </q-card>
            </div>

            <!-- Placeholder cards -->
            <div class="col-6 col-sm-4 col-md-3" v-for="n in 3" :key="n">
                <q-card class="game-card game-card--soon">
                    <q-card-section class="text-center q-pa-lg">
                        <div style="font-size: 52px">🎮</div>
                        <div class="text-subtitle1 text-bold text-grey-5 q-mt-sm">敬请期待</div>
                        <div class="text-caption text-grey-4">更多游戏即将上线</div>
                    </q-card-section>
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
.game-card--soon {
    opacity: 0.45;
    pointer-events: none;
}
</style>
