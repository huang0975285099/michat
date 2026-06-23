<template>
    <div class="lock-screen" :class="{ visible: show }">
        <!-- 背景遮罩 -->
        <div class="lock-bg" />

        <!-- 锁定界面 -->
        <div class="lock-card">
            <!-- 头像 + 昵称 -->
            <div style="display: flex;justify-content: center;align-items: center;">
                <deterministic-avatar
                    :seed="identity.chatId"
                    :size="40"
                />
                <div class="text-h6 text-weight-bold q-ml-sm">
                    {{ identity.nickname }}
                </div>
            </div>
            <div class="text-caption text-grey-7 q-mb-md q-mt-md">输入安全码解锁</div>

            <!-- 6 位 PIN 输入 -->
            <div class="pin-row q-mb-lg">
                <input
                    v-for="i in 6"
                    :key="i"
                    ref="pinRefs"
                    v-model="pinValues[i - 1]"
                    maxlength="1"
                    type="password"
                    inputmode="numeric"
                    pattern="[0-9]*"
                    class="pin-input"
                    :class="{
                        active: activeIdx === i - 1,
                        filled: pinValues[i - 1],
                        error: showError,
                    }"
                    @input="onPinInput(i - 1, $event)"
                    @keydown="onPinKeydown(i - 1, $event)"
                    @focus="activeIdx = i - 1"
                />
            </div>

            <!-- 错误提示 -->
            <div v-if="showError" class="text-negative text-center q-mb-md">
                <div>安全码错误</div>
                <div class="text-caption">
                    剩余 {{ remainingAttempts }} 次机会
                </div>
            </div>

            <!-- 冷却提示 -->
            <div v-if="isCoolingDown" class="text-orange text-center q-mb-md">
                <q-icon name="lock_clock" size="sm" />
                <span class="q-ml-xs"
                    >错误次数过多，请 {{ cooldownSeconds }} 秒后重试</span
                >
            </div>

            <!-- 解锁按钮 -->
            <q-btn
                v-if="!isCoolingDown"
                unelevated
                color="primary"
                label="解锁"
                class="full-width"
                :disable="pinCode.length !== 6 || isUnlocking"
                :loading="isUnlocking"
                @click="tryUnlock"
            />

            <!-- 底部 -->
            <div class="text-caption text-grey-7 text-center q-mt-lg">
                忘记安全码？
                <span class="text-negative cursor-pointer" @click="confirmReset"
                    >注销账号</span
                >
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useQuasar } from "quasar";
import { useRouter } from "vue-router";
import { useIdentityStore } from "src/stores/identity";
import DeterministicAvatar from "src/components/DeterministicAvatar.vue";

const $q = useQuasar();
const router = useRouter();
const identity = useIdentityStore();

const show = computed(() => identity.isLocked);
const pinValues = ref(["", "", "", "", "", ""]);
const pinCode = computed(() => pinValues.value.join(""));
const activeIdx = ref(0);
const pinRefs = ref([]);
const isUnlocking = ref(false);
const showError = ref(false);
const isCoolingDown = ref(false);
const cooldownSeconds = ref(0);
let cooldownTimer = null;

// 错误计数（sessionStorage，页面刷新清零）
const MAX_ATTEMPTS = 5;
const COOLDOWN_SEC = 30 * 60; // 30 分钟

// 错误计数（localStorage 持久化，关闭浏览器不丢失）
const errorCount = ref(
    parseInt(localStorage.getItem("sec_code_errors") || "0"),
);
const remainingAttempts = computed(() =>
    Math.max(0, MAX_ATTEMPTS - errorCount.value),
);

// 初始化时检查是否在冷却中
onMounted(() => {
    const cooldownEnd = parseInt(
        localStorage.getItem("sec_code_cooldown_end") || "0",
    );
    if (cooldownEnd > Date.now()) {
        startCooldown(cooldownEnd);
    }
});

onUnmounted(() => {
    if (cooldownTimer) clearTimeout(cooldownTimer);
});

// 当锁定状态变为 false 时重置
watch(
    () => identity.isLocked,
    (locked) => {
        if (!locked) {
            resetPin();
            showError.value = false;
            errorCount.value = 0;
            sessionStorage.removeItem("sec_code_errors");
        }
    },
);

function resetPin() {
    pinValues.value = ["", "", "", "", "", ""];
    activeIdx.value = 0;
    nextTick(() => pinRefs.value[0]?.focus());
}

function onPinInput(idx, event) {
    let val = event.target.value.replace(/[^0-9]/g, "");
    pinValues.value[idx] = val.slice(0, 1);
    showError.value = false;

    if (val && idx < 5) {
        pinRefs.value[idx + 1]?.focus();
    }

    // 自动提交
    if (pinCode.value.length === 6) {
        tryUnlock();
    }
}

function onPinKeydown(idx, event) {
    if (event.key === "Backspace" && !pinValues.value[idx] && idx > 0) {
        pinRefs.value[idx - 1]?.focus();
        pinValues.value[idx - 1] = "";
        event.preventDefault();
    }
}

async function tryUnlock() {
    if (pinCode.value.length !== 6 || isUnlocking.value || isCoolingDown.value)
        return;

    isUnlocking.value = true;
    const success = await identity.unlockWithCode(pinCode.value);
    isUnlocking.value = false;

    if (success) {
        // 重置错误计数
        errorCount.value = 0;
        localStorage.removeItem("sec_code_errors");
        return;
    }

    // 失败
    errorCount.value++;
    localStorage.setItem("sec_code_errors", errorCount.value.toString());
    showError.value = true;

    if (errorCount.value >= MAX_ATTEMPTS) {
        // 进入冷却
        const cooldownEnd = Date.now() + COOLDOWN_SEC * 1000;
        localStorage.setItem("sec_code_cooldown_end", cooldownEnd.toString());
        startCooldown(cooldownEnd);
    } else {
        resetPin();
    }
}

// 确认注销（忘记密码时）
function confirmReset() {
    $q.dialog({
        title: "注销账号",
        message:
            "这将永久删除您的账号、好友关系和所有数据，无法恢复！确定继续吗？",
        cancel: true,
        persistent: true,
        ok: "确定注销",
        color: "negative",
    }).onOk(() => {
        // 二次确认
        $q.dialog({
            title: "最后确认",
            message:
                "此操作不可撤销！您的身份将永久丢失，即使有私钥备份也无法恢复！",
            cancel: true,
            persistent: true,
            ok: "我确定要注销",
            color: "negative",
        }).onOk(async () => {
            await identity.clear();
            router.replace("/#/init");
        });
    });
}

function startCooldown(endTime) {
    isCoolingDown.value = true;
    pinValues.value = ["", "", "", "", "", ""];

    const update = () => {
        const remaining = Math.ceil((endTime - Date.now()) / 1000);
        if (remaining <= 0) {
            isCoolingDown.value = false;
            cooldownSeconds.value = 0;
            localStorage.removeItem("sec_code_cooldown_end");
            return;
        }
        cooldownSeconds.value = remaining;
        cooldownTimer = setTimeout(update, 1000);
    };
    update();
}
</script>

<style scoped>
.lock-screen {
    position: fixed;
    inset: 0;
    z-index: 5000;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s;
}
.lock-screen.visible {
    opacity: 1;
    pointer-events: auto;
}
.lock-bg {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(10px);
}
.lock-card {
    position: relative;
    z-index: 1;
    background: white;
    border-radius: 24px;
    padding: 32px 24px;
    width: 360px;
    max-width: 92vw;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.pin-row {
    display: flex;
    justify-content: center;
    gap: 6px;
    flex-wrap: nowrap;
}

.pin-input {
    width: calc((100% - 30px) / 6);
    min-width: 0;
    max-width: 48px;
    height: 52px;
    text-align: center;
    font-size: 24px;
    font-weight: 700;
    border: 2px solid #e0e0e0;
    border-radius: 12px;
    outline: none;
    background: #fafafa;
    color: #333;
    caret-color: transparent;
    transition: all 0.15s;
    flex-shrink: 0;
}
.pin-input::placeholder {
    color: #ccc;
}
.pin-input.active {
    border-color: #1976d2;
    background: #fff;
    box-shadow: 0 0 0 3px rgba(25, 118, 210, 0.15);
}
.pin-input.filled {
    border-color: #1976d2;
    color: #1976d2;
}
.pin-input.error {
    border-color: #c62828;
    background: #ffebee;
    color: #c62828;
}
.cursor-pointer {
    cursor: pointer;
    text-decoration: underline;
}
</style>
