<template>
    <q-page class="q-pa-md">
        <!-- 微信浏览器引导遮罩（永久显示，不可关闭） -->
        <div v-if="isWechat" class="wechat-guide-overlay">
            <div class="wechat-guide-content">
                <div class="wechat-guide-arrow">
                    <q-icon name="arrow_upward" size="48px" color="white" />
                </div>
                <div class="wechat-guide-text">
                    <div class="text-h6 q-mb-sm">请使用浏览器打开</div>
                    <div class="text-body2">
                        点击右上角 <strong>⋮</strong> 菜单<br />
                        选择「在浏览器中打开」
                    </div>
                </div>
            </div>
        </div>

        <q-card class="q-mb-md">
            <q-card-section class="text-center">
                <deterministic-avatar
                    :seed="identity.chatId"
                    :size="80"
                    class="q-mb-sm"
                />
                <div class="row items-center justify-center q-gutter-xs">
                    <span class="text-h6">{{ identity.nickname }}</span>
                    <q-btn
                        flat round dense size="sm" icon="edit" color="grey-6"
                        @click="openNicknameDialog"
                    >
                        <q-tooltip>修改昵称</q-tooltip>
                    </q-btn>
                </div>
            </q-card-section>
        </q-card>

        <q-list bordered separator rounded-borders>
            <q-item clickable @click="copyId">
                <q-item-section avatar
                    ><q-icon name="fingerprint"
                /></q-item-section>
                <q-item-section>
                    <q-item-label
                        >复制我的 Chat ID: {{ identity.chatId }}</q-item-label
                    >
                    <q-item-label caption
                        >分享给朋友，让他们添加你</q-item-label
                    >
                </q-item-section>
            </q-item>

            <q-item
                clickable
                @click="generateInviteLink"
            >
                <q-item-section avatar
                    ><q-icon name="link" color="primary"
                /></q-item-section>
                <q-item-section>
                    <q-item-label>邀请好友</q-item-label>
                    <q-item-label caption
                        >生成邀请链接，好友注册后自动添加你</q-item-label
                    >
                </q-item-section>
            </q-item>

            <q-item clickable @click="openBackupDialog">
                <q-item-section avatar
                    ><q-icon name="backup" color="orange"
                /></q-item-section>
                <q-item-section>
                    <q-item-label>备份私钥</q-item-label>
                    <q-item-label caption class="text-orange"
                        >重要：清除浏览器数据前必须备份</q-item-label
                    >
                </q-item-section>
            </q-item>

            <!-- 安全码设置（未设置时） -->
            <q-item
                v-if="!identity.hasCode"
                clickable
                @click="showSetupDialog = true"
            >
                <q-item-section avatar
                    ><q-icon name="lock" color="primary"
                /></q-item-section>
                <q-item-section>
                    <q-item-label>设置安全码</q-item-label>
                    <q-item-label caption
                        >6 位数字，防止他人查看聊天记录</q-item-label
                    >
                </q-item-section>
            </q-item>

            <!-- 安全码管理（已设置时） -->
            <q-item
                v-if="identity.hasCode"
                clickable
                @click="showLockSettings = true"
            >
                <q-item-section avatar
                    ><q-icon
                        name="lock"
                        :color="identity.isLocked ? 'negative' : 'positive'"
                /></q-item-section>
                <q-item-section>
                    <q-item-label>安全码</q-item-label>
                    <q-item-label caption>
                        {{ identity.isLocked ? "已锁定" : "已解锁" }}
                        · 超时
                        {{
                            timeoutOptions.find(
                                (o) => o.value === identity.lockTimeout,
                            )?.label ?? identity.lockTimeout + " 小时"
                        }}
                        自动锁定
                    </q-item-label>
                </q-item-section>
                <q-item-section side>
                    <q-icon name="chevron_right" color="grey-6" />
                </q-item-section>
            </q-item>

            <q-item clickable @click="openMicDialog">
                <q-item-section avatar
                    ><q-icon name="mic" color="teal"
                /></q-item-section>
                <q-item-section>
                    <q-item-label>麦克风检测</q-item-label>
                    <q-item-label caption
                        >检查麦克风权限和设备是否正常</q-item-label
                    >
                </q-item-section>
            </q-item>

            <q-item clickable @click="confirmClear">
                <q-item-section avatar
                    ><q-icon name="delete_forever" color="negative"
                /></q-item-section>
                <q-item-section>
                    <q-item-label class="text-negative">注销账号</q-item-label>
                    <q-item-label caption
                        >将删除账号信息及所有好友关系，不可恢复</q-item-label
                    >
                </q-item-section>
            </q-item>
        </q-list>

        <q-btn
            v-if="identity.hasCode"
            outline
            color="negative"
            label="立即锁定"
            class="full-width q-mt-lg"
            @click="doLockNow"
        />

        <!-- 备份对话框 -->
        <q-dialog v-model="showBackupDialog">
            <q-card style="min-width: 320px">
                <q-card-section>
                    <div class="text-h6">私钥备份</div>
                    <div class="text-caption text-orange q-mb-md">
                        请将以下内容保存到安全的地方。丢失私钥将永久无法恢复身份。
                    </div>
                    <div class="text-caption text-grey q-mb-xs">
                        私钥（Base64）
                    </div>
                    <q-input
                        :model-value="privKey"
                        readonly
                        outlined
                        dense
                        type="textarea"
                        rows="4"
                        class="q-mb-sm"
                    />
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn
                        flat
                        label="复制私钥"
                        color="primary"
                        @click="copyPrivKey"
                    />
                    <q-btn flat label="关闭" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- 设置安全码对话框 -->
        <q-dialog v-model="showSetupDialog">
            <q-card style="min-width: 340px">
                <q-card-section>
                    <div class="text-h6">设置安全码</div>
                    <div class="text-caption text-grey q-mb-md">
                        请输入 6
                        位数字安全码。安全码不会存储在任何地方，请务必牢记。
                    </div>

                    <div class="text-caption text-grey q-mb-xs">安全码</div>
                    <q-input
                        v-model="setupCode1"
                        outlined
                        dense
                        maxlength="6"
                        inputmode="numeric"
                        placeholder="6位数字"
                        class="q-mb-sm"
                    />

                    <div class="text-caption text-grey q-mb-xs">再次输入</div>
                    <q-input
                        v-model="setupCode2"
                        outlined
                        dense
                        maxlength="6"
                        inputmode="numeric"
                        placeholder="6位数字"
                        class="q-mb-sm"
                    />

                    <div class="text-caption text-grey q-mb-xs">
                        超时自动锁定
                    </div>
                    <q-select
                        v-model="setupTimeout"
                        :options="timeoutOptions"
                        outlined
                        dense
                        emit-value
                        map-options
                        class="q-mb-md"
                    />

                    <div class="text-caption text-negative q-mb-sm">
                        ⚠️ 忘记安全码 =
                        身份永久丢失。建议写在纸上或使用密码管理器备份。
                    </div>
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="取消" v-close-popup />
                    <q-btn
                        unelevated
                        color="primary"
                        label="确认设置"
                        :disable="!canSetup"
                        @click="doSetup"
                    />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- 安全码设置对话框 -->
        <q-dialog v-model="showLockSettings">
            <q-card style="min-width: 300px">
                <q-card-section>
                    <div class="text-h6">安全码设置</div>

                    <div class="q-mb-md">
                        <div class="text-subtitle2 q-mb-xs">超时自动锁定</div>
                        <q-select
                            v-model="editTimeout"
                            :options="timeoutOptions"
                            outlined
                            dense
                            emit-value
                            map-options
                        />
                    </div>

                    <q-btn
                        outline
                        color="grey-7"
                        label="关闭安全码"
                        class="full-width"
                        @click="showDisableConfirm = true"
                    />
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="关闭" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- 关闭安全码确认 -->
        <q-dialog v-model="showDisableConfirm">
            <q-card style="min-width: 300px">
                <q-card-section>
                    <div class="text-h6">关闭安全码</div>
                    <div class="text-caption text-negative q-mb-md">
                        关闭后如您的手机丢失时，消息可能被他人查看。
                    </div>
                    <div class="text-caption text-grey q-mb-xs">
                        输入安全码确认
                    </div>
                    <q-input
                        v-model="disableCode"
                        outlined
                        dense
                        maxlength="6"
                        inputmode="numeric"
                        placeholder="6位数字"
                    />
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="取消" v-close-popup />
                    <q-btn
                        unelevated
                        color="negative"
                        label="确认关闭"
                        :disable="disableCode.length !== 6"
                        @click="doDisable"
                    />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- 修改昵称对话框 -->
        <q-dialog v-model="showNicknameDialog">
            <q-card style="min-width: 300px">
                <q-card-section>
                    <div class="text-h6">修改昵称</div>
                    <div class="text-caption text-grey q-mb-md">最多 8 个字符</div>
                    <q-input
                        v-model="newNickname"
                        outlined
                        dense
                        maxlength="8"
                        placeholder="请输入新昵称"
                        autofocus
                        counter
                        @keyup.enter="doUpdateNickname"
                    />
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="取消" v-close-popup />
                    <q-btn
                        unelevated
                        color="primary"
                        label="确认"
                        :disable="!newNickname.trim() || newNickname.trim().length > 8"
                        :loading="updatingNickname"
                        @click="doUpdateNickname"
                    />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- 邀请好友对话框 -->
        <q-dialog v-model="showInviteDialog">
            <q-card style="min-width: 320px">
                <q-card-section>
                    <div class="text-h6">邀请好友</div>
                    <div class="text-caption text-grey q-mb-md">
                        将此链接发送给好友，好友点击链接注册后会自动发送好友申请给你。
                    </div>
                    <div class="text-caption text-grey q-mb-xs">邀请链接</div>
                    <q-input
                        :model-value="inviteLink"
                        readonly
                        outlined
                        dense
                        type="textarea"
                        rows="3"
                        class="q-mb-sm"
                    />
                    <div class="text-caption text-grey">链接长期有效</div>
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn
                        flat
                        label="复制链接"
                        color="primary"
                        @click="copyInviteLink"
                    />
                    <q-btn flat label="关闭" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- 麦克风检测对话框 -->
        <q-dialog v-model="showMicDialog" @hide="stopMicTest">
            <q-card style="min-width: 340px">
                <q-card-section>
                    <div class="text-h6">麦克风检测</div>
                </q-card-section>

                <q-card-section>
                    <div v-if="micStatus === 'idle'" class="text-center q-py-lg">
                        <q-icon name="mic" size="48px" color="grey-5" />
                        <div class="text-grey q-mt-sm">点击下方按钮开始检测</div>
                    </div>

                    <div v-else-if="micStatus === 'checking'" class="text-center q-py-lg">
                        <q-spinner color="primary" size="48px" />
                        <div class="text-grey q-mt-sm">正在请求麦克风权限...</div>
                    </div>

                    <div v-else-if="micStatus === 'error'" class="text-center q-py-lg">
                        <q-icon name="mic_off" size="48px" color="negative" />
                        <div class="text-negative q-mt-sm">{{ micError }}</div>
                        <q-btn
                            flat
                            color="primary"
                            label="重试"
                            class="q-mt-sm"
                            @click="startMicTest"
                        />
                    </div>

                    <div v-else-if="micStatus === 'ok'">
                        <div class="row items-center q-mb-md">
                            <q-icon name="check_circle" color="positive" size="24px" class="q-mr-sm" />
                            <span class="text-positive">麦克风正常</span>
                        </div>

                        <div class="text-caption text-grey q-mb-xs">音量</div>
                        <q-linear-progress
                            :value="micLevel"
                            color="teal"
                            track-color="grey-3"
                            size="20px"
                            rounded
                            class="q-mb-md"
                        >
                            <div class="absolute-full flex flex-center">
                                <q-badge color="white" text-color="teal" :label="Math.round(micLevel * 100) + '%'" />
                            </div>
                        </q-linear-progress>

                        <div class="text-caption text-grey q-mb-xs">选择设备</div>
                        <q-select
                            v-model="selectedMicId"
                            :options="micDevices"
                            outlined
                            dense
                            emit-value
                            map-options
                            class="q-mb-sm"
                            @update:model-value="switchMicDevice"
                        />
                    </div>
                </q-card-section>

                <q-card-actions align="right">
                    <q-btn
                        v-if="micStatus === 'idle'"
                        unelevated
                        color="primary"
                        label="开始检测"
                        @click="startMicTest"
                    />
                    <q-btn flat label="关闭" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>
    </q-page>
</template>

<script setup>
import { ref, watch, computed, onMounted } from "vue";
import { useQuasar } from "quasar";
import { useRouter } from "vue-router";
import { useIdentityStore } from "src/stores/identity";
import DeterministicAvatar from "src/components/DeterministicAvatar.vue";

const $q = useQuasar();
const router = useRouter();
const identity = useIdentityStore();

// 浏览器检测
const isWechat = ref(false);


function detectBrowser() {
    const ua = navigator.userAgent;
    isWechat.value = /MicroMessenger/i.test(ua);
}

onMounted(() => {
    detectBrowser();
});

const showBackupDialog = ref(false);
const privKey = ref("");

// 修改昵称
const showNicknameDialog = ref(false);
const newNickname = ref("");
const updatingNickname = ref(false);

function openNicknameDialog() {
    newNickname.value = identity.nickname;
    showNicknameDialog.value = true;
}

async function doUpdateNickname() {
    const name = newNickname.value.trim();
    if (!name || name.length > 8) return;
    updatingNickname.value = true;
    try {
        await identity.updateNickname(name);
        $q.notify({ type: "positive", message: "昵称已更新" });
        showNicknameDialog.value = false;
    } catch (e) {
        $q.notify({ type: "negative", message: e.response?.data?.error || "修改失败，请重试" });
    } finally {
        updatingNickname.value = false;
    }
}

// 邀请好友
const showInviteDialog = ref(false);
const inviteLink = ref("");

// 安全码设置
const showSetupDialog = ref(false);
const setupCode1 = ref("");
const setupCode2 = ref("");
const setupTimeout = ref(1 / 6);
const timeoutOptions = [
    { label: "10 分钟", value: 1 / 6 },
    { label: "30 分钟", value: 0.5 },
    { label: "1 小时", value: 1 },
    { label: "2 小时", value: 2 },
];

const canSetup = computed(
    () =>
        /^\d{6}$/.test(setupCode1.value) &&
        setupCode1.value === setupCode2.value,
);

// 安全码管理
const showLockSettings = ref(false);
const editTimeout = ref(identity.lockTimeout);
const showDisableConfirm = ref(false);
const disableCode = ref("");

// 监听 editTimeout 变化自动保存
watch(editTimeout, async (val) => {
    if (showLockSettings.value && val) {
        await identity.setLockTimeout(val);
    }
});

// 打开备份对话框
function openBackupDialog() {
    showBackupDialog.value = true;
}

// 备份
watch(showBackupDialog, async (open) => {
    if (open) {
        try {
            privKey.value = await identity.exportKey();
        } catch {
            privKey.value = "（无法读取，请先解锁）";
        }
    } else {
        privKey.value = "";
    }
});

function copyId() {
    navigator.clipboard.writeText(identity.chatId);
    $q.notify({ type: "positive", message: "Chat ID 已复制" });
}

function generateInviteLink() {
    const isElectron = window.location.protocol === 'file:';
    const isCapacitorAndroid = window.location.protocol === 'https:' && window.location.hostname === 'localhost';
    const baseUrl = (isElectron || isCapacitorAndroid) ? 'https://yb.yzs88.com' : window.location.origin;
    inviteLink.value = baseUrl + "/#/init?invite=" + identity.chatId;
    showInviteDialog.value = true;
}

function copyInviteLink() {
    navigator.clipboard.writeText(inviteLink.value);
    $q.notify({ type: "positive", message: "邀请链接已复制" });
}

function copyPrivKey() {
    navigator.clipboard.writeText(privKey.value);
    $q.notify({ type: "positive", message: "私钥已复制，请妥善保管" });
}

async function doSetup() {
    if (!canSetup.value) return;
    try {
        await identity.enableSecurityCode(setupCode1.value, setupTimeout.value);
        $q.notify({ type: "positive", message: "安全码设置成功，请牢记！" });
        showSetupDialog.value = false;
        setupCode1.value = "";
        setupCode2.value = "";
    } catch (e) {
        $q.notify({ type: "negative", message: e.message });
    }
}

function doLockNow() {
    identity.lockNow();
    showLockSettings.value = false;
    $q.notify({ type: "info", message: "已锁定" });
}

async function doDisable() {
    try {
        await identity.disableSecCode(disableCode.value);
        $q.notify({ type: "positive", message: "安全码已关闭" });
        showDisableConfirm.value = false;
        showLockSettings.value = false;
        disableCode.value = "";
    } catch (e) {
        $q.notify({ type: "negative", message: e.message });
    }
}

// 麦克风检测
const showMicDialog = ref(false);
const micStatus = ref("idle");
const micError = ref("");
const micLevel = ref(0);
const micDevices = ref([]);
const selectedMicId = ref(null);

let micStream = null;
let micAnalyser = null;
let micAnimFrame = null;
let micAudioCtx = null;

function openMicDialog() {
    micStatus.value = "idle";
    micError.value = "";
    micLevel.value = 0;
    showMicDialog.value = true;
}

function micErrorMessage(e) {
    if (e.name === "NotFoundError" || e.name === "DevicesNotFoundError") {
        return "未找到麦克风设备，请检查设备连接";
    }
    if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
        return "麦克风权限被拒绝，请在浏览器设置中允许麦克风访问";
    }
    if (e.name === "NotReadableError") {
        return "麦克风被其他程序占用，请关闭后重试";
    }
    return "无法访问麦克风：" + (e.message || e.name);
}

async function startMicTest() {
    micStatus.value = "checking";
    micError.value = "";
    micLevel.value = 0;
    stopMicStream();

    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: selectedMicId.value
                ? { deviceId: { exact: selectedMicId.value } }
                : true,
        });

        micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = micAudioCtx.createMediaStreamSource(micStream);
        micAnalyser = micAudioCtx.createAnalyser();
        micAnalyser.fftSize = 256;
        source.connect(micAnalyser);

        const dataArray = new Uint8Array(micAnalyser.frequencyBinCount);

        function updateLevel() {
            micAnalyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const avg = sum / dataArray.length;
            micLevel.value = Math.min(avg / 128, 1);
            micAnimFrame = requestAnimationFrame(updateLevel);
        }
        updateLevel();

        await enumerateMics();
        micStatus.value = "ok";
    } catch (e) {
        micStatus.value = "error";
        micError.value = micErrorMessage(e);
    }
}

async function enumerateMics() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        micDevices.value = devices
            .filter((d) => d.kind === "audioinput")
            .map((d) => ({
                label: d.label || "未知设备",
                value: d.deviceId,
            }));
        if (!selectedMicId.value && micDevices.value.length > 0) {
            selectedMicId.value = micDevices.value[0].value;
        }
    } catch {}
}

async function switchMicDevice(deviceId) {
    selectedMicId.value = deviceId;
    if (micStatus.value === "ok") {
        startMicTest();
    }
}

function stopMicStream() {
    if (micAnimFrame) {
        cancelAnimationFrame(micAnimFrame);
        micAnimFrame = null;
    }
    if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
    }
    if (micAudioCtx) {
        micAudioCtx.close().catch(() => {});
        micAudioCtx = null;
    }
    micAnalyser = null;
}

function stopMicTest() {
    stopMicStream();
    micStatus.value = "idle";
    micLevel.value = 0;
}

function confirmClear() {
    $q.dialog({
        title: "注销账号",
        message:
            "这将永久删除您的账号、好友关系和所有数据，无法恢复！确定继续吗？",
        cancel: true,
        persistent: true,
        ok: "确定注销",
        color: "negative",
    }).onOk(async () => {
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
</script>

<style scoped>
/* 微信浏览器引导遮罩 */
.wechat-guide-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding: 20px;
    cursor: pointer;
}

.wechat-guide-content {
    text-align: center;
    color: white;
    animation: fadeInUp 0.5s ease;
}

.wechat-guide-arrow {
    margin-right: 10px;
    margin-bottom: 16px;
    animation: bounce 1s infinite;
}

.wechat-guide-text {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 24px 32px;
    margin-top: 8px;
    text-align: center;
}

@keyframes fadeInUp {
    from {
        opacity: 0;
        transform: translateY(20px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes bounce {
    0%,
    100% {
        transform: translateY(0);
    }
    50% {
        transform: translateY(-10px);
    }
}


</style>
