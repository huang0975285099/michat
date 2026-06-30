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
            <div class="text-h6 q-ml-sm">$FIST 明细</div>
            <q-space />
            <q-chip dense color="amber-9" text-color="white" class="fist-chip">
                ⚡ {{ fistStore.balance.toLocaleString() }} $FIST
            </q-chip>
        </div>

        <div
            v-if="loading && !fistStore.transactions.length"
            class="text-center q-py-xl"
        >
            <q-spinner-dots color="amber-8" size="38px" />
        </div>
        <div v-else-if="!fistStore.transactions.length" class="empty-hint">
            暂无流水记录，去人机对战赢取 $FIST 吧
        </div>
        <template v-else>
            <div
                v-for="t in fistStore.transactions"
                :key="t.id"
                class="tx-row"
            >
                <div class="tx-main">
                    <div class="tx-label">{{ txLabel(t) }}</div>
                    <div class="tx-time">{{ fmtTime(t.created_at) }}</div>
                </div>
                <div class="tx-right">
                    <div
                        class="tx-amount"
                        :class="
                            t.amount >= 0 ? 'tx-amount--in' : 'tx-amount--out'
                        "
                    >
                        {{ t.amount >= 0 ? "+" : ""
                        }}{{ t.amount.toLocaleString() }}
                    </div>
                    <div class="tx-balance">
                        余额 {{ t.balance_after.toLocaleString() }}
                    </div>
                </div>
            </div>
            <div class="row justify-center q-my-md">
                <q-btn
                    v-if="fistStore.txHasMore"
                    flat
                    dense
                    color="amber-7"
                    label="加载更多"
                    @click="fistStore.fetchTransactions()"
                />
                <div v-else class="text-caption text-grey-6">没有更多了</div>
            </div>
        </template>
    </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useFistStore } from "src/stores/fist";
import { TX_TYPE_LABEL, fmtTime } from "../game/ironfistMeta";

defineEmits(["back"]);

const fistStore = useFistStore();
const loading = ref(false);

function txLabel(t) {
    return t.remark || TX_TYPE_LABEL[t.type] || t.type;
}

onMounted(async () => {
    loading.value = true;
    await fistStore.fetchTransactions(true);
    loading.value = false;
});
</script>

<style scoped>
.fist-chip {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
}
.sub-view {
    min-height: 100dvh;
}
.empty-hint {
    text-align: center;
    color: rgba(255, 255, 255, 0.45);
    font-size: 13px;
    padding: 48px 16px;
}

.tx-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    margin-bottom: 8px;
}
.tx-main {
    min-width: 0;
}
.tx-label {
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.tx-time {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 2px;
}
.tx-right {
    text-align: right;
    flex: 0 0 auto;
}
.tx-amount {
    font-size: 16px;
    font-weight: 800;
}
.tx-amount--in {
    color: #6ee7a0;
}
.tx-amount--out {
    color: #ff7a7a;
}
.tx-balance {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 1px;
}
</style>
