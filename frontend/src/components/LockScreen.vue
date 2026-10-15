<template>
    <div class="lock-screen" :class="{ visible: show }">
        <!-- background mask -->
        <div class="lock-bg" />

        <!-- Lock interface -->
        <form class="lock-card" @submit.prevent="tryUnlock">
            <input type="hidden" name="username" :value="identity.chatId" autocomplete="username" />
            <!-- Avatar + Nickname -->
            <div style="display: flex;justify-content: center;align-items: center;">
                <deterministic-avatar
                    :seed="identity.chatId"
                    :size="40"
                />
                <div class="text-h6 text-weight-bold q-ml-sm">
                    {{ identity.nickname }}
                </div>
            </div>
            <div class="text-caption text-grey-7 q-mb-md q-mt-md">{{ t("lock.enterCode") }}</div>

            <q-input ref="pinInput" v-model="pinCode" outlined type="password" maxlength="128" autocomplete="current-password" class="q-mb-lg" :aria-label="t('lock.enterCode')" :disable="isUnlocking || isCoolingDown" @update:model-value="showError = false" />

            <!-- Error message -->
            <div v-if="showError" class="text-negative text-center q-mb-md">
                <div>{{ t("lock.codeError") }}</div>
                <div class="text-caption">
                    {{ t("lock.attemptsLeft", { count: remainingAttempts }) }}
                </div>
            </div>

            <!-- Cooling Tips -->
            <div v-if="isCoolingDown" class="text-orange text-center q-mb-md">
                <q-icon name="lock_clock" size="sm" />
                <span class="q-ml-xs"
                    >{{ t("lock.cooldown", { seconds: cooldownSeconds }) }}</span
                >
            </div>

            <!-- Unlock button -->
            <q-btn
                v-if="!isCoolingDown"
                unelevated
                color="primary"
                :label="t('lock.unlock')"
                class="full-width"
                :disable="!pinCode.length || isUnlocking"
                :loading="isUnlocking"
                type="submit"
            />

            <!-- bottom -->
            <div class="text-caption text-grey-7 text-center q-mt-lg">
                {{ t("lock.forgotCode") }}
                <span class="text-negative cursor-pointer" @click="confirmReset"
                    >{{ t("lock.deleteAccount") }}</span
                >
            </div>
        </form>
    </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useQuasar } from "quasar";
import { useRouter } from "vue-router";
import { useIdentityStore } from "src/stores/identity";
import DeterministicAvatar from "src/components/DeterministicAvatar.vue";
import { useI18n } from "src/i18n";
import {
    MAX_SECURITY_CODE_ATTEMPTS,
    registerSecurityCodeFailure,
    securityCodeCooldownSeconds,
} from "src/services/security-lock.mjs";

const $q = useQuasar();
const router = useRouter();
const identity = useIdentityStore();
const { t } = useI18n();

const show = computed(() => identity.isLocked || identity.restoringLocalData);
const pinCode = ref("");
const pinInput = ref(null);
const isUnlocking = ref(false);
const showError = ref(false);
const isCoolingDown = ref(false);
const cooldownSeconds = ref(0);
let cooldownTimer = null;

// Error count (persistent in localStorage, not lost when closing the browser)
const errorCount = ref(
    parseInt(localStorage.getItem("sec_code_errors") || "0"),
);
const remainingAttempts = computed(() =>
    Math.max(0, MAX_SECURITY_CODE_ATTEMPTS - errorCount.value),
);

// Check if it is cooling during initialization
onMounted(() => {
    const cooldownEnd = parseInt(
        localStorage.getItem("sec_code_cooldown_end") || "0",
    );
    if (cooldownEnd > Date.now()) {
        startCooldown(cooldownEnd);
    } else if (cooldownEnd) {
        clearFailedAttempts();
    }
});

onUnmounted(() => {
    if (cooldownTimer) clearTimeout(cooldownTimer);
});

// Reset when lock status changes to false
watch(
    () => identity.isLocked,
    (locked) => {
        if (!locked) {
            resetPin();
            showError.value = false;
            clearFailedAttempts();
        }
    },
);

function resetPin() {
    pinCode.value = "";
    nextTick(() => {
        if (show.value && !isCoolingDown.value) pinInput.value?.focus();
    });
}

async function tryUnlock() {
    if (!pinCode.value.length || isUnlocking.value || isCoolingDown.value)
        return;

    isUnlocking.value = true;
    try {
        const success = await identity.unlockWithCode(pinCode.value);
        if (success) {
            clearFailedAttempts();
            return;
        }

        const failure = registerSecurityCodeFailure(errorCount.value);
        errorCount.value = failure.errorCount;
        localStorage.setItem("sec_code_errors", errorCount.value.toString());
        showError.value = true;

        if (failure.cooldownEnd) {
            localStorage.setItem(
                "sec_code_cooldown_end",
                failure.cooldownEnd.toString(),
            );
            startCooldown(failure.cooldownEnd);
        } else {
            resetPin();
        }
    } catch (error) {
        console.warn("[lock] Unable to unlock security code", error);
        showError.value = false;
        resetPin();
        $q.notify({ type: "negative", message: t("lock.unlockFailed") });
    } finally {
        isUnlocking.value = false;
    }
}

function clearFailedAttempts() {
    errorCount.value = 0;
    localStorage.removeItem("sec_code_errors");
    localStorage.removeItem("sec_code_cooldown_end");
}

// Confirm logout (when you forget your password)
function confirmReset() {
    $q.dialog({
        title: t("lock.deleteTitle"),
        message: t("lock.deleteMessage"),
        cancel: true,
        persistent: true,
        ok: t("lock.deleteConfirm"),
        color: "negative",
    }).onOk(() => {
        // Second confirmation
        $q.dialog({
            title: t("lock.finalTitle"),
            message: t("lock.finalMessage"),
            cancel: true,
            persistent: true,
            ok: t("lock.finalConfirm"),
            color: "negative",
        }).onOk(async () => {
            try {
                await identity.clear();
                router.replace("/#/init");
            } catch {
                $q.notify({ type: "negative", message: t("lock.deleteFailed") });
            }
        });
    });
}

function startCooldown(endTime) {
    isCoolingDown.value = true;
    pinCode.value = "";

    const update = () => {
        const remaining = securityCodeCooldownSeconds(endTime);
        if (remaining <= 0) {
            isCoolingDown.value = false;
            cooldownSeconds.value = 0;
            showError.value = false;
            clearFailedAttempts();
            resetPin();
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

.cursor-pointer {
    cursor: pointer;
    text-decoration: underline;
}
</style>
