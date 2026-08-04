<template>
    <q-page class="q-pa-md">
        <!-- WeChat browser boot mask (permanent display, cannot be closed) -->
        <div v-if="isWechat" class="wechat-guide-overlay">
            <div class="wechat-guide-content">
                <div class="wechat-guide-arrow">
                    <q-icon name="arrow_upward" size="48px" color="white" />
                </div>
                <div class="wechat-guide-text">
                    <div class="text-h6 q-mb-sm">Please use a browser to open</div>
                    <div class="text-body2">
                        Click on the upper right corner <strong>⋮</strong> menu<br />
                        Choose「Open in browser」
                    </div>
                </div>
            </div>
        </div>

        <q-card class="q-mb-md">
            <q-card-section style="display: flex;justify-content: space-evenly;">
                <deterministic-avatar
                    :seed="identity.chatId"
                    :size="60"
                    class="q-mb-sm"
                />
                <div class="row items-center justify-center q-gutter-xs">
                    <div>
                        <span class="text-h6">{{ identity.nickname }}</span>
                        <q-btn
                            flat round dense size="sm" icon="edit" color="grey-6"
                            @click="openNicknameDialog"
                        >
                            <q-tooltip>{{ t("profile.editNickname") }}</q-tooltip>
                        </q-btn>
                    </div>
                    <div>
                        {{ t("profile.myId") }}
                    </div>
                </div>
            </q-card-section>
        </q-card>

        <q-list bordered separator rounded-borders>
            <q-item clickable @click="copyId">
                <q-item-section avatar
                    ><q-icon name="fingerprint"
                /></q-item-section>
                <q-item-section>
                    <q-item-label>{{ t("profile.copyId", { id: identity.chatId }) }}</q-item-label>
                    <q-item-label caption>{{ t("profile.shareId") }}</q-item-label>
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
                    <q-item-label>{{ t("profile.inviteFriend") }}</q-item-label>
                    <q-item-label caption>{{ t("profile.inviteHint") }}</q-item-label>
                </q-item-section>
            </q-item>

            <q-item clickable @click="openBackupDialog">
                <q-item-section avatar
                    ><q-icon name="backup" color="orange"
                /></q-item-section>
                <q-item-section>
                    <q-item-label>{{ t("profile.backupKey") }}</q-item-label>
                    <q-item-label caption class="text-orange">{{ t("profile.backupWarning") }}</q-item-label>
                </q-item-section>
            </q-item>

            <!-- Security code setting (when not set) -->
            <q-item
                v-if="!identity.hasCode"
                clickable
                @click="showSetupDialog = true"
            >
                <q-item-section avatar
                    ><q-icon name="lock" color="primary"
                /></q-item-section>
                <q-item-section>
                    <q-item-label>{{ t("profile.setupCode") }}</q-item-label>
                    <q-item-label caption>{{ t("profile.setupCodeHint") }}</q-item-label>
                </q-item-section>
            </q-item>

            <!-- Security code management (when set) -->
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
                    <q-item-label>{{ t("profile.securityCode") }}</q-item-label>
                    <q-item-label caption>
                        {{ identity.isLocked ? t("profile.locked") : t("profile.unlocked") }}
                        · {{ t("profile.autoLock", { duration: lockTimeoutLabel(identity.lockTimeout) }) }}
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
                    <q-item-label>{{ t("profile.micTest") }}</q-item-label>
                    <q-item-label caption>{{ t("profile.micTestHint") }}</q-item-label>
                </q-item-section>
            </q-item>

            <q-item clickable @click="openCamDialog">
                <q-item-section avatar
                    ><q-icon name="videocam" color="indigo"
                /></q-item-section>
                <q-item-section>
                    <q-item-label>{{ t("profile.cameraTest") }}</q-item-label>
                    <q-item-label caption>{{ t("profile.cameraTestHint") }}</q-item-label>
                </q-item-section>
            </q-item>

            <q-item clickable @click="showLanguageDialog = true">
                <q-item-section avatar>
                    <q-icon name="language" color="primary" />
                </q-item-section>
                <q-item-section>
                    <q-item-label>{{ t("profile.language") }}</q-item-label>
                    <q-item-label caption>{{ t("profile.languageHint") }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                    <span class="text-grey-7">{{ currentLanguageLabel }}</span>
                </q-item-section>
            </q-item>

            <q-item clickable @click="confirmClear">
                <q-item-section avatar
                    ><q-icon name="delete_forever" color="negative"
                /></q-item-section>
                <q-item-section>
                    <q-item-label class="text-negative">{{ t("profile.deleteAccount") }}</q-item-label>
                    <q-item-label caption>{{ t("profile.deleteAccountHint") }}</q-item-label>
                </q-item-section>
            </q-item>
        </q-list>

        <!-- <q-btn
            v-if="identity.hasCode"
            outline
            color="negative"
            label="Lock now"
            class="full-width q-mt-lg"
            @click="doLockNow"
        /> -->

        <!-- Version number + update check -->
        <div class="text-center text-caption text-grey-6 q-mt-xs">
            <div>v{{ appVersion }}<span v-if="buildDate"> · {{ buildDate }}</span></div>
            <div class="q-mt-xs">
                <span v-if="updateState === 'checking'" class="text-grey">{{ t("profile.checkingUpdate") }}</span>
                <span v-else-if="updateState === 'latest'" class="text-positive">{{ t("profile.latest") }}</span>
                <a
                    v-else-if="updateState === 'outdated'"
                    class="text-primary"
                    style="cursor: pointer; text-decoration: none"
                    @click="onUpdateClick"
                >{{ t("profile.outdated", { version: latestVersion }) }}</a>
                <span v-else class="text-grey">{{ t("profile.checkFailed") }}</span>
            </div>
        </div>

        <q-dialog v-model="showLanguageDialog">
            <q-card style="min-width: 300px">
                <q-card-section class="text-h6">{{ t("profile.languageTitle") }}</q-card-section>
                <q-list separator>
                    <q-item
                        v-for="option in languageOptions"
                        :key="option.value"
                        v-ripple
                        clickable
                        @click="selectLanguage(option.value)"
                    >
                        <q-item-section>{{ option.label }}</q-item-section>
                        <q-item-section side>
                            <q-icon v-if="locale === option.value" name="check" color="primary" />
                        </q-item-section>
                    </q-item>
                </q-list>
                <q-card-actions align="right">
                    <q-btn flat :label="t('common.close')" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- Backup dialog -->
        <q-dialog v-model="showBackupDialog">
            <q-card style="min-width: 320px">
                <q-card-section>
                    <div class="text-h6">Private key backup</div>
                    <div class="text-caption text-orange q-mb-md">
                        Please save the following content to a safe place。Losing your private key will permanently render your identity irrecoverable。
                    </div>
                    <div class="text-caption text-grey q-mb-xs">
                        private key（Base64）
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
                        label="Copy private key"
                        color="primary"
                        @click="copyPrivKey"
                    />
                    <q-btn flat label="close" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- Set security code dialog box -->
        <q-dialog v-model="showSetupDialog">
            <q-card style="min-width: 340px">
                <q-card-section>
                    <div class="text-h6">Set security code</div>
                    <div class="text-caption text-grey q-mb-md">
                        Please enter 6
                        digit security code。Security codes are not stored anywhere，Please remember。
                    </div>

                    <div class="text-caption text-grey q-mb-xs">Security code</div>
                    <q-input
                        v-model="setupCode1"
                        outlined
                        dense
                        maxlength="6"
                        inputmode="numeric"
                        placeholder="6digits"
                        class="q-mb-sm"
                    />

                    <div class="text-caption text-grey q-mb-xs">Enter again</div>
                    <q-input
                        v-model="setupCode2"
                        outlined
                        dense
                        maxlength="6"
                        inputmode="numeric"
                        placeholder="6digits"
                        class="q-mb-sm"
                    />

                    <div class="text-caption text-grey q-mb-xs">
                        Automatically lock after timeout
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
                        ⚠️ Forgot security code =
                        Identity permanently lost。It is recommended to write it down on paper or use a password manager to back it up。
                    </div>
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="Cancel" v-close-popup />
                    <q-btn
                        unelevated
                        color="primary"
                        label="Confirm settings"
                        :disable="!canSetup"
                        @click="doSetup"
                    />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- Security code setting dialog box -->
        <q-dialog v-model="showLockSettings">
            <q-card style="min-width: 300px">
                <q-card-section>
                    <div class="text-h6">Security code settings</div>

                    <div class="q-mb-md">
                        <div class="text-subtitle2 q-mb-xs">Automatically lock after timeout</div>
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
                        label="Turn off security code"
                        class="full-width"
                        @click="showDisableConfirm = true"
                    />
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="close" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- Turn off security code confirmation -->
        <q-dialog v-model="showDisableConfirm">
            <q-card style="min-width: 300px">
                <q-card-section>
                    <div class="text-h6">Turn off security code</div>
                    <div class="text-caption text-negative q-mb-md">
                        After shutting down if your phone is lost，Message may be viewed by others。
                    </div>
                    <div class="text-caption text-grey q-mb-xs">
                        Enter security code to confirm
                    </div>
                    <q-input
                        v-model="disableCode"
                        outlined
                        dense
                        maxlength="6"
                        inputmode="numeric"
                        placeholder="6digits"
                    />
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="Cancel" v-close-popup />
                    <q-btn
                        unelevated
                        color="negative"
                        label="Confirm close"
                        :disable="disableCode.length !== 6"
                        @click="doDisable"
                    />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- Modify nickname dialog box -->
        <q-dialog v-model="showNicknameDialog">
            <q-card style="min-width: 300px">
                <q-card-section>
                    <div class="text-h6">Modify nickname</div>
                    <div class="text-caption text-grey q-mb-md">most 8 characters</div>
                    <q-input
                        v-model="newNickname"
                        outlined
                        dense
                        maxlength="8"
                        placeholder="Please enter a new nickname"
                        autofocus
                        counter
                        @keyup.enter="doUpdateNickname"
                    />
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="Cancel" v-close-popup />
                    <q-btn
                        unelevated
                        color="primary"
                        label="Confirm"
                        :disable="!newNickname.trim() || newNickname.trim().length > 8"
                        :loading="updatingNickname"
                        @click="doUpdateNickname"
                    />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- Invite friends dialog box -->
        <q-dialog v-model="showInviteDialog">
            <q-card style="min-width: 320px">
                <q-card-section>
                    <div class="text-h6">Invite friends</div>
                    <div class="text-caption text-grey q-mb-md">
                        Send this link to a friend，After your friend clicks the link to register, a friend application will be automatically sent to you.。
                    </div>
                    <div class="text-caption text-grey q-mb-xs">Invitation link</div>
                    <q-input
                        :model-value="inviteLink"
                        readonly
                        outlined
                        dense
                        type="textarea"
                        rows="3"
                        class="q-mb-sm"
                    />
                    <div class="text-caption text-grey">The link is valid for a long time</div>
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn
                        flat
                        label="Copy link"
                        color="primary"
                        @click="copyInviteLink"
                    />
                    <q-btn flat label="close" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- Microphone detection dialog -->
        <q-dialog v-model="showMicDialog" @hide="stopMicTest">
            <q-card style="min-width: 340px">
                <q-card-section>
                    <div class="text-h6">Microphone detection</div>
                </q-card-section>

                <q-card-section>
                    <div v-if="micStatus === 'idle'" class="text-center q-py-lg">
                        <q-icon name="mic" size="48px" color="grey-5" />
                        <div class="text-grey q-mt-sm">Click the button below to start testing</div>
                    </div>

                    <div v-else-if="micStatus === 'checking'" class="text-center q-py-lg">
                        <q-spinner color="primary" size="48px" />
                        <div class="text-grey q-mt-sm">Requesting microphone permission...</div>
                    </div>

                    <div v-else-if="micStatus === 'error'" class="text-center q-py-lg">
                        <q-icon name="mic_off" size="48px" color="negative" />
                        <div class="text-negative q-mt-sm">{{ micError }}</div>
                        <q-btn
                            flat
                            color="primary"
                            label="Try again"
                            class="q-mt-sm"
                            @click="startMicTest"
                        />
                    </div>

                    <div v-else-if="micStatus === 'ok'">
                        <div class="row items-center q-mb-md">
                            <q-icon name="check_circle" color="positive" size="24px" class="q-mr-sm" />
                            <span class="text-positive">Microphone is normal</span>
                        </div>

                        <div class="text-caption text-grey q-mb-xs">Volume</div>
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

                        <div class="text-caption text-grey q-mb-xs">Select device</div>
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
                        label="Start testing"
                        @click="startMicTest"
                    />
                    <q-btn flat label="close" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>

        <!-- Camera detection dialog box -->
        <q-dialog v-model="showCamDialog" @hide="stopCamTest">
            <q-card style="min-width: 340px">
                <q-card-section>
                    <div class="text-h6">Camera detection</div>
                </q-card-section>

                <q-card-section>
                    <div v-if="camStatus === 'idle'" class="text-center q-py-lg">
                        <q-icon name="videocam" size="48px" color="grey-5" />
                        <div class="text-grey q-mt-sm">Click the button below to start testing</div>
                    </div>

                    <div v-else-if="camStatus === 'checking'" class="text-center q-py-lg">
                        <q-spinner color="primary" size="48px" />
                        <div class="text-grey q-mt-sm">Requesting camera permission...</div>
                    </div>

                    <div v-else-if="camStatus === 'error'" class="text-center q-py-lg">
                        <q-icon name="videocam_off" size="48px" color="negative" />
                        <div class="text-negative q-mt-sm">{{ camError }}</div>
                        <q-btn
                            flat
                            color="primary"
                            label="Try again"
                            class="q-mt-sm"
                            @click="startCamTest"
                        />
                    </div>

                    <div v-show="camStatus === 'ok'">
                        <div class="row items-center q-mb-md">
                            <q-icon name="check_circle" color="positive" size="24px" class="q-mr-sm" />
                            <span class="text-positive">The camera is normal</span>
                        </div>

                        <video
                            ref="camVideo"
                            class="cam-preview q-mb-md"
                            autoplay
                            playsinline
                            muted
                        ></video>

                        <div class="text-caption text-grey q-mb-xs">Select device</div>
                        <q-select
                            v-model="selectedCamId"
                            :options="camDevices"
                            outlined
                            dense
                            emit-value
                            map-options
                            class="q-mb-sm"
                            @update:model-value="switchCamDevice"
                        />
                    </div>
                </q-card-section>

                <q-card-actions align="right">
                    <q-btn
                        v-if="camStatus === 'idle'"
                        unelevated
                        color="primary"
                        label="Start testing"
                        @click="startCamTest"
                    />
                    <q-btn flat label="close" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>
    </q-page>
</template>

<script setup>
import { ref, watch, computed, onMounted, nextTick } from "vue";
import { useQuasar } from "quasar";
import { useRouter } from "vue-router";
import { useIdentityStore } from "src/stores/identity";
import {
    APP_VERSION,
    BUILD_TIME,
    cmpVersion,
    fetchVersionInfo,
    isNativeClient,
    forceRefresh,
} from "src/services/version";
import DeterministicAvatar from "src/components/DeterministicAvatar.vue";
import { useI18n } from "src/i18n";

const $q = useQuasar();
const router = useRouter();
const identity = useIdentityStore();
const { locale, setLocale, t } = useI18n();
const showLanguageDialog = ref(false);
const languageOptions = computed(() => [
    { label: t("profile.chinese"), value: "zh-CN" },
    { label: t("profile.english"), value: "en-US" },
]);
const currentLanguageLabel = computed(
    () => languageOptions.value.find((option) => option.value === locale.value)?.label,
);

function selectLanguage(value) {
    setLocale(value);
    showLanguageDialog.value = false;
}

// Version number (injected at build time, see quasar.config.js)
const appVersion = APP_VERSION || "unknown";
const buildDate = (BUILD_TIME || "").slice(0, 10);

// Update check: Compare with the latest online version returned by the backend /api/version
const updateState = ref("checking"); // checking | latest | outdated | unknown
const latestVersion = ref("");
const updateUrl = ref("");

async function checkVersion() {
    updateState.value = "checking";
    try {
        const info = await fetchVersionInfo();
        latestVersion.value = info.latest || "";
        updateUrl.value = info.url || "";
        if (!latestVersion.value || !APP_VERSION) {
            updateState.value = "unknown";
            return;
        }
        updateState.value =
            cmpVersion(APP_VERSION, latestVersion.value) < 0
                ? "outdated"
                : "latest";
    } catch {
        updateState.value = "unknown";
    }
}

async function onUpdateClick() {
    // Native side (desktop/Android): Open the download page to update the installation package
    if (isNativeClient()) {
        if (updateUrl.value) window.open(updateUrl.value, "_blank");
        return;
    }
    // Browser/PWA: clear cache + log out of SW and refresh, users do not need to force refresh manually
    $q.loading.show({ message: "Updating to the latest version…" });
    await forceRefresh();
}

// Browser detection
const isWechat = ref(false);


function detectBrowser() {
    const ua = navigator.userAgent;
    isWechat.value = /MicroMessenger/i.test(ua);
}

onMounted(() => {
    detectBrowser();
    checkVersion();
});

const showBackupDialog = ref(false);
const privKey = ref("");

// Modify nickname
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
        $q.notify({ type: "positive", message: "Nickname has been updated" });
        showNicknameDialog.value = false;
    } catch (e) {
        $q.notify({ type: "negative", message: e.response?.data?.error || "Modification failed，Please try again" });
    } finally {
        updatingNickname.value = false;
    }
}

// Invite friends
const showInviteDialog = ref(false);
const inviteLink = ref("");

// Security code settings
const showSetupDialog = ref(false);
const setupCode1 = ref("");
const setupCode2 = ref("");
const setupTimeout = ref(1 / 6);
const timeoutOptions = [
    { label: "10 minutes", value: 1 / 6 },
    { label: "30 minutes", value: 0.5 },
    { label: "1 hours", value: 1 },
    { label: "2 hours", value: 2 },
];

function lockTimeoutLabel(value) {
    if (value < 1) return t("profile.minutes", { count: Math.round(value * 60) });
    return t("profile.hours", { count: value });
}

const canSetup = computed(
    () =>
        /^\d{6}$/.test(setupCode1.value) &&
        setupCode1.value === setupCode2.value,
);

// Security code management
const showLockSettings = ref(false);
const editTimeout = ref(identity.lockTimeout);
const showDisableConfirm = ref(false);
const disableCode = ref("");

// Monitor editTimeout changes and automatically save them
watch(editTimeout, async (val) => {
    if (showLockSettings.value && val) {
        await identity.setLockTimeout(val);
    }
});

// Open backup dialog
function openBackupDialog() {
    showBackupDialog.value = true;
}

// backup
watch(showBackupDialog, async (open) => {
    if (open) {
        try {
            privKey.value = await identity.exportKey();
        } catch {
            privKey.value = "（Unable to read，Please unlock first）";
        }
    } else {
        privKey.value = "";
    }
});

function copyId() {
    navigator.clipboard.writeText(identity.chatId);
    $q.notify({ type: "positive", message: "Chat ID Copied" });
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
    $q.notify({ type: "positive", message: "Invitation link copied" });
}

function copyPrivKey() {
    navigator.clipboard.writeText(privKey.value);
    $q.notify({ type: "positive", message: "Private key copied，Please keep it properly" });
}

async function doSetup() {
    if (!canSetup.value) return;
    try {
        await identity.enableSecurityCode(setupCode1.value, setupTimeout.value);
        $q.notify({ type: "positive", message: "Security code set successfully，please remember！" });
        showSetupDialog.value = false;
        setupCode1.value = "";
        setupCode2.value = "";
    } catch (e) {
        $q.notify({ type: "negative", message: e.message });
    }
}

// function doLockNow() {
//     identity.lockNow();
//     showLockSettings.value = false;
// $q.notify({ type: "info", message: "Locked" });
// }

async function doDisable() {
    try {
        await identity.disableSecCode(disableCode.value);
        $q.notify({ type: "positive", message: "Security code is closed" });
        showDisableConfirm.value = false;
        showLockSettings.value = false;
        disableCode.value = "";
    } catch (e) {
        $q.notify({ type: "negative", message: e.message });
    }
}

// Microphone detection
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
        return "Microphone device not found，Please check device connection";
    }
    if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
        return "Microphone permission denied，Please allow microphone access in your browser settings";
    }
    if (e.name === "NotReadableError") {
        return "The microphone is occupied by another program，Please close and try again";
    }
    return "Unable to access microphone：" + (e.message || e.name);
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
                label: d.label || "unknown device",
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

// Camera detection
const showCamDialog = ref(false);
const camStatus = ref("idle");
const camError = ref("");
const camDevices = ref([]);
const selectedCamId = ref(null);
const camVideo = ref(null);

let camStream = null;

function openCamDialog() {
    camStatus.value = "idle";
    camError.value = "";
    showCamDialog.value = true;
}

function camErrorMessage(e) {
    if (e.name === "NotFoundError" || e.name === "DevicesNotFoundError") {
        return "Camera device not found，Please check device connection";
    }
    if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
        return "Camera permission denied，Please allow camera access in your browser settings";
    }
    if (e.name === "NotReadableError") {
        return "The camera is occupied by other programs，Please close and try again";
    }
    return "Unable to access camera：" + (e.message || e.name);
}

async function startCamTest() {
    camStatus.value = "checking";
    camError.value = "";
    stopCamStream();

    try {
        camStream = await navigator.mediaDevices.getUserMedia({
            video: selectedCamId.value
                ? { deviceId: { exact: selectedCamId.value } }
                : true,
        });

        await enumerateCams();
        camStatus.value = "ok";
        await nextTick();
        if (camVideo.value) {
            camVideo.value.srcObject = camStream;
            camVideo.value.play().catch(() => {});
        }
    } catch (e) {
        camStatus.value = "error";
        camError.value = camErrorMessage(e);
    }
}

async function enumerateCams() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        camDevices.value = devices
            .filter((d) => d.kind === "videoinput")
            .map((d) => ({
                label: d.label || "unknown device",
                value: d.deviceId,
            }));
        if (!selectedCamId.value && camDevices.value.length > 0) {
            selectedCamId.value = camDevices.value[0].value;
        }
    } catch {}
}

async function switchCamDevice(deviceId) {
    selectedCamId.value = deviceId;
    if (camStatus.value === "ok") {
        startCamTest();
    }
}

function stopCamStream() {
    if (camVideo.value) {
        camVideo.value.srcObject = null;
    }
    if (camStream) {
        camStream.getTracks().forEach((t) => t.stop());
        camStream = null;
    }
}

function stopCamTest() {
    stopCamStream();
    camStatus.value = "idle";
}

function confirmClear() {
    $q.dialog({
        title: "Cancel account",
        message:
            "This will permanently delete your account、Friendships and all data，Unable to recover！Are you sure to continue?？",
        cancel: true,
        persistent: true,
        ok: "Confirm logout",
        color: "negative",
    }).onOk(async () => {
        // Second confirmation
        $q.dialog({
            title: "final confirmation",
            message:
                "This action is irreversible！Your identity will be permanently lost，Even if there is a backup of the private key, it cannot be restored！",
            cancel: true,
            persistent: true,
            ok: "I'm sure I want to log out",
            color: "negative",
        }).onOk(async () => {
            await identity.clear();
            router.replace("/#/init");
        });
    });
}
</script>

<style scoped>
/* WeChat browser boot mask */
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

/* Camera detection preview */
.cam-preview {
    width: 100%;
    aspect-ratio: 4 / 3;
    background: #000;
    border-radius: 8px;
    object-fit: cover;
    /* Mirror display, in line with user habits */
    transform: scaleX(-1);
}


</style>
