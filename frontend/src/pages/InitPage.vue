<template>
    <div class="flex flex-center column q-pa-lg" style="min-height: 100vh">
        <img :src="logoUrl" alt="Yunmi" width="80" style="border-radius: 16px" @click="goHome" />
        <div class="text-h5 text-weight-bold q-mb-sm q-mt-sm">Yunmi</div>
        <!-- <div class="text-body2 text-grey q-mb-xl text-center">
            End-to-end encrypted chat
        </div> -->

        <!-- No invitation code prompt (native app does not display) -->
        <q-card
            v-if="!inviteCode && !isNativeApp"
            class="q-mb-md bg-orange-1"
            style="width: 100%; max-width: 400px"
        >
            <q-card-section class="text-center">
                <q-icon
                    name="card_giftcard"
                    size="40px"
                    color="orange"
                    class="q-mb-sm"
                />
                <div class="text-subtitle2 text-orange">{{ t("init.needInvite") }}</div>
                <div class="text-caption text-grey q-mb-md">
                    {{ t("init.needInviteHint") }}
                </div>
            </q-card-section>
        </q-card>

        <!-- Invitation prompt -->
        <q-card
            v-if="inviteCode && inviterInfo"
            class="q-mb-md bg-blue-1"
            style="width: 100%; max-width: 400px"
        >
            <q-card-section class="text-center">
                <q-icon
                    name="person_add"
                    size="40px"
                    color="primary"
                    class="q-mb-sm"
                />
                <div class="text-subtitle2">
                    {{ t("init.invitedBy", { id: inviterInfo.inviter_chat_id }) }}
                </div>
                <div class="text-caption text-grey">
                    {{ t("init.autoFriend") }}
                </div>
            </q-card-section>
        </q-card>

        <!-- Invalid invitation code prompt -->
        <q-card
            v-if="inviteCode && inviteError"
            class="q-mb-md bg-orange-1"
            style="width: 100%; max-width: 400px"
        >
            <q-card-section class="text-center">
                <q-icon
                    name="warning"
                    size="40px"
                    color="orange"
                    class="q-mb-sm"
                />
                <div class="text-subtitle2 text-orange">{{ t("init.inviteExpired") }}</div>
                <div class="text-caption text-grey q-mb-md">
                    {{ t("init.inviteExpiredHint") }}
                </div>
                <q-btn
                    outline
                    color="primary"
                    :label="t('init.home')"
                    @click="goHome"
                />
            </q-card-section>
        </q-card>

        <!-- Create a new identity (invitation code is valid or native app) -->
        <q-card
            v-if="(inviteCode && inviterInfo) || isNativeApp"
            style="width: 100%; max-width: 400px"
        >
            <q-card-section>
                <div class="text-subtitle1 text-weight-medium q-mb-sm">
                    {{ t("init.createTitle") }}
                </div>
                <div class="text-caption text-grey q-mb-md">
                    {{ t("init.createHint") }}
                </div>
                <q-btn
                    unelevated
                    color="primary"
                    :label="inviterInfo ? t('init.acceptCreate') : t('init.createTitle')"
                    class="full-width"
                    :loading="creating"
                    @click="create"
                />
            </q-card-section>
        </q-card>

        <!-- restore identity -->
        <q-expansion-item
            :label="t('init.restoreTitle')"
            class="q-mt-md"
            style="width: 100%; max-width: 400px"
            :default-opened="!!restorePrivKey || !inviteCode"
        >
            <q-card>
                <q-card-section>
                    <q-input
                        v-model="restorePrivKey"
                        :label="t('init.privateKey')"
                        type="textarea"
                        dense
                        outlined
                        class="q-mb-sm"
                        rows="3"
                    />
                    <div class="text-caption text-grey q-mb-sm">
                        {{ t("init.restoreHint") }}
                    </div>
                    <q-btn
                        unelevated
                        color="secondary"
                        :label="t('init.restore')"
                        class="full-width"
                        :loading="restoring"
                        @click="restore"
                    />
                </q-card-section>
            </q-card>
        </q-expansion-item>
    </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useQuasar } from "quasar";
import { useIdentityStore } from "src/stores/identity";
import {
    importPrivateKey,
    exportPrivateKey,
    signChallenge,
} from "src/services/crypto";
import { identityApi, inviteApi } from "src/services/api";
import { isNativeShell } from "src/services/platform";
import { registerPushToken } from "src/boot/chat-service";
import logoUrl from "src/assets/logo.png";
import { useI18n } from "src/i18n";

const $q = useQuasar();
const router = useRouter();
const route = useRoute();
const identity = useIdentityStore();
const { t } = useI18n();

const creating = ref(false);
const restoring = ref(false);
const restorePrivKey = ref("");

// Invitation related
const inviteCode = ref("");
const inviterInfo = ref(null);
const inviteError = ref(false);

// Native clients (Electron / Tauri desktop, Capacitor Android) can also be registered without an invitation code
const isNativeApp = isNativeShell();

function goHome() {
    router.push("/");
}

onMounted(async () => {
    // Get invitation code from URL
    const code = route.query.invite;
    if (code) {
        inviteCode.value = code;
        // Verify invitation code
        try {
            const { data } = await inviteApi.validate(code);
            if (data.valid) {
                inviterInfo.value = data;
            }
        } catch {
            inviteError.value = true;
        }
    }

    // Load existing private key
    try {
        const key = await exportPrivateKey();
        if (key) restorePrivKey.value = key;
    } catch {
        // IndexedDB has no private key and is ignored.
    }
});

async function create() {
    creating.value = true;
    try {
        const inviterChatId = await identity.initialize(inviteCode.value);
        $q.notify({
            type: "positive",
            message: t("init.created", { name: identity.nickname }),
        });
        if (inviterChatId) {
            $q.notify({
                type: "info",
                message: t("init.requestSent", { id: inviterChatId }),
            });
        }
        router.replace("/chats");
    } catch (e) {
        $q.notify({ type: "negative", message: t("init.createFailed", { error: e.message }) });
    } finally {
        creating.value = false;
    }
}

async function restore() {
    if (!restorePrivKey.value) {
        $q.notify({ type: "warning", message: t("init.enterKey") });
        return;
    }
    restoring.value = true;
    try {
        // 1. Import the private key and derive the public key
        const pubKeyB64 = await importPrivateKey(restorePrivKey.value.trim());

        // 2. Get the challenge code
        const { data: challengeData } = await identityApi.challenge(pubKeyB64);

        // 3. Sign the challenge code with the private key to prove ownership of the private key
        const signature = await signChallenge(challengeData.nonce);

        // 4. Submit public key + signature + challenge code in exchange for new session_token
        const { data } = await identityApi.reauth(
            pubKeyB64,
            signature,
            challengeData.nonce,
        );
        localStorage.setItem("session_token", data.session_token);
        localStorage.setItem("chat_id", data.chat_id);
        localStorage.setItem("nickname", data.nickname);

        // 5. Load identity status and jump
        await identity.load();
        if (identity.isReady) {
            registerPushToken(); //Report the Aurora token after restoring your identity
            $q.notify({
                type: "positive",
                message: t("init.restored", { name: data.nickname }),
            });
            router.replace("/chats");
        } else {
            $q.notify({ type: "warning", message: t("init.restoredNotReady") });
        }
    } catch (e) {
        const errMsg = e.response?.data?.error || t("init.networkError");
        $q.notify({
            type: "negative",
            message: t("init.restoreFailed", { error: errMsg }),
        });
    } finally {
        restoring.value = false;
    }
}
</script>
