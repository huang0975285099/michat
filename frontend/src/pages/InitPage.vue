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
                <div class="text-subtitle2 text-orange">Please get the invitation code</div>
                <div class="text-caption text-grey q-mb-md">
                    Yunmi adopts invitation-based registration，Please get the invitation link from your friend
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
                    from {{ inviterInfo.inviter_chat_id }} invitation
                </div>
                <div class="text-caption text-grey">
                    After registration, the other party will be automatically added as a friend.
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
                <div class="text-subtitle2 text-orange">The invitation link has expired</div>
                <div class="text-caption text-grey q-mb-md">
                    The invitation code has expired or is invalid，Please get a new invitation link
                </div>
                <q-btn
                    outline
                    color="primary"
                    label="Visit homepage"
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
                    Create new identity
                </div>
                <div class="text-caption text-grey q-mb-md">
                    The system will generate a unique encrypted identity for you。The private key is only saved on this device，Be sure to back up。
                </div>
                <q-btn
                    unelevated
                    color="primary"
                    :label="inviterInfo ? 'Accept the invitation and create an identity' : 'Create new identity'"
                    class="full-width"
                    :loading="creating"
                    @click="create"
                />
            </q-card-section>
        </q-card>

        <!-- restore identity -->
        <q-expansion-item
            label="Already have a private key？restore identity"
            class="q-mt-md"
            style="width: 100%; max-width: 400px"
            :default-opened="!!restorePrivKey || !inviteCode"
        >
            <q-card>
                <q-card-section>
                    <q-input
                        v-model="restorePrivKey"
                        label="private key（Base64）"
                        type="textarea"
                        dense
                        outlined
                        class="q-mb-sm"
                        rows="3"
                    />
                    <div class="text-caption text-grey q-mb-sm">
                        Paste the private key to restore，No need Chat ID
                    </div>
                    <q-btn
                        unelevated
                        color="secondary"
                        label="restore identity"
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

const $q = useQuasar();
const router = useRouter();
const route = useRoute();
const identity = useIdentityStore();

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
            message: `Identity created successfully：${identity.nickname}`,
        });
        if (inviterChatId) {
            $q.notify({
                type: "info",
                message: `Already sent to ${inviterChatId} Send friend request`,
            });
        }
        router.replace("/chats");
    } catch (e) {
        $q.notify({ type: "negative", message: "Creation failed：" + e.message });
    } finally {
        creating.value = false;
    }
}

async function restore() {
    if (!restorePrivKey.value) {
        $q.notify({ type: "warning", message: "Please fill in the private key" });
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
                message: `Identity restored successfully：${data.nickname}`,
            });
            router.replace("/chats");
        } else {
            $q.notify({ type: "warning", message: "Identity restored but server not ready" });
        }
    } catch (e) {
        const errMsg = e.response?.data?.error || "network error";
        $q.notify({
            type: "negative",
            message: "Recovery failed：" + errMsg,
        });
    } finally {
        restoring.value = false;
    }
}
</script>
