<template>
    <div class="flex flex-center column q-pa-lg" style="min-height: 100vh">
        <img :src="logoUrl" alt="云密" width="80" style="border-radius: 16px" @click="goHome" />
        <div class="text-h5 text-weight-bold q-mb-sm q-mt-sm">云密</div>
        <div class="text-body2 text-grey q-mb-xl text-center">
            端到端加密聊天
        </div>

        <!-- 无邀请码提示（native app 不显示） -->
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
                <div class="text-subtitle2 text-orange">请获取邀请码</div>
                <div class="text-caption text-grey q-mb-md">
                    云密采用邀请制注册，请从好友那获取邀请链接
                </div>
            </q-card-section>
        </q-card>

        <!-- 邀请提示 -->
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
                    来自 {{ inviterInfo.inviter_chat_id }} 的邀请
                </div>
                <div class="text-caption text-grey">
                    注册后将自动添加对方为好友
                </div>
            </q-card-section>
        </q-card>

        <!-- 邀请码无效提示 -->
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
                <div class="text-subtitle2 text-orange">邀请链接已失效</div>
                <div class="text-caption text-grey q-mb-md">
                    邀请码过期或无效，请获取新的邀请链接
                </div>
                <q-btn
                    outline
                    color="primary"
                    label="访问首页"
                    @click="goHome"
                />
            </q-card-section>
        </q-card>

        <!-- 创建新身份（邀请码有效 或 native app） -->
        <q-card
            v-if="(inviteCode && inviterInfo) || isNativeApp"
            style="width: 100%; max-width: 400px"
        >
            <q-card-section>
                <div class="text-subtitle1 text-weight-medium q-mb-sm">
                    创建新身份
                </div>
                <div class="text-caption text-grey q-mb-md">
                    系统将为你生成唯一的加密身份。私钥仅保存在本设备，请务必备份。
                </div>
                <q-btn
                    unelevated
                    color="primary"
                    :label="inviterInfo ? '接受邀请并创建身份' : '创建新身份'"
                    class="full-width"
                    :loading="creating"
                    @click="create"
                />
            </q-card-section>
        </q-card>

        <!-- 恢复身份 -->
        <q-expansion-item
            label="已有私钥？恢复身份"
            class="q-mt-md"
            style="width: 100%; max-width: 400px"
            :default-opened="!!restorePrivKey || !inviteCode"
        >
            <q-card>
                <q-card-section>
                    <q-input
                        v-model="restorePrivKey"
                        label="私钥（Base64）"
                        type="textarea"
                        dense
                        outlined
                        class="q-mb-sm"
                        rows="3"
                    />
                    <div class="text-caption text-grey q-mb-sm">
                        粘贴私钥即可恢复，无需 Chat ID
                    </div>
                    <q-btn
                        unelevated
                        color="secondary"
                        label="恢复身份"
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
import { registerPushToken } from "src/boot/chat-service";
import logoUrl from "src/assets/logo.png";

const $q = useQuasar();
const router = useRouter();
const route = useRoute();
const identity = useIdentityStore();

const creating = ref(false);
const restoring = ref(false);
const restorePrivKey = ref("");

// 邀请相关
const inviteCode = ref("");
const inviterInfo = ref(null);
const inviteError = ref(false);

// Electron (file://) 或 Capacitor Android (https://localhost) 无邀请码也可注册
const isNativeApp = window.location.protocol === 'file:' ||
    (window.location.protocol === 'https:' && window.location.hostname === 'localhost');

function goHome() {
    router.push("/");
}

onMounted(async () => {
    // 从 URL 获取邀请码
    const code = route.query.invite;
    if (code) {
        inviteCode.value = code;
        // 验证邀请码
        try {
            const { data } = await inviteApi.validate(code);
            if (data.valid) {
                inviterInfo.value = data;
            }
        } catch {
            inviteError.value = true;
        }
    }

    // 加载已有私钥
    try {
        const key = await exportPrivateKey();
        if (key) restorePrivKey.value = key;
    } catch {
        // IndexedDB 无私钥，忽略
    }
});

async function create() {
    creating.value = true;
    try {
        const inviterChatId = await identity.initialize(inviteCode.value);
        $q.notify({
            type: "positive",
            message: `身份创建成功：${identity.nickname}`,
        });
        if (inviterChatId) {
            $q.notify({
                type: "info",
                message: `已向 ${inviterChatId} 发送好友申请`,
            });
        }
        router.replace("/chats");
    } catch (e) {
        $q.notify({ type: "negative", message: "创建失败：" + e.message });
    } finally {
        creating.value = false;
    }
}

async function restore() {
    if (!restorePrivKey.value) {
        $q.notify({ type: "warning", message: "请填写私钥" });
        return;
    }
    restoring.value = true;
    try {
        // 1. 导入私钥，推导公钥
        const pubKeyB64 = await importPrivateKey(restorePrivKey.value.trim());

        // 2. 获取挑战码
        const { data: challengeData } = await identityApi.challenge(pubKeyB64);

        // 3. 用私钥对挑战码签名，证明私钥所有权
        const signature = await signChallenge(challengeData.nonce);

        // 4. 提交公钥 + 签名 + 挑战码，换取新 session_token
        const { data } = await identityApi.reauth(
            pubKeyB64,
            signature,
            challengeData.nonce,
        );
        localStorage.setItem("session_token", data.session_token);
        localStorage.setItem("chat_id", data.chat_id);
        localStorage.setItem("nickname", data.nickname);

        // 5. 加载身份状态并跳转
        await identity.load();
        if (identity.isReady) {
            registerPushToken(); // 恢复身份后上报极光 token
            $q.notify({
                type: "positive",
                message: `身份恢复成功：${data.nickname}`,
            });
            router.replace("/chats");
        } else {
            $q.notify({ type: "warning", message: "身份恢复但服务端未就绪" });
        }
    } catch (e) {
        const errMsg = e.response?.data?.error || "网络错误";
        $q.notify({
            type: "negative",
            message: "恢复失败：" + errMsg,
        });
    } finally {
        restoring.value = false;
    }
}
</script>
