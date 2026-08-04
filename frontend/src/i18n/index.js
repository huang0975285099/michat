import { computed, readonly, ref } from "vue";

const STORAGE_KEY = "michat_language";
const SUPPORTED_LOCALES = ["zh-CN", "en-US"];

const messages = {
    "zh-CN": {
        common: { close: "关闭" },
        nav: { chats: "聊天", friends: "好友", games: "链游", profile: "我" },
        header: {
            app: "云密",
            chat: "聊天",
            friends: "好友",
            games: "区块链游戏",
            profile: "我的资料",
            lockNow: "立即锁定",
            refresh: "刷新连接",
            disconnected: "网络已断开，正在重新连接...",
            reconnected: "已重新连接",
            locked: "已锁定",
        },
        update: {
            required: "需要更新",
            requiredMessage: "当前版本（v{version}）过低，无法继续使用，请更新到最新版本。",
            updateNow: "立即更新",
        },
        profile: {
            editNickname: "修改昵称",
            myId: "我的 ID",
            copyId: "复制我的 Chat ID: {id}",
            shareId: "分享给朋友，让他们添加你",
            inviteFriend: "邀请好友",
            inviteHint: "生成邀请链接，好友注册后自动添加你",
            backupKey: "备份私钥",
            backupWarning: "重要：清除浏览器数据前必须备份",
            setupCode: "设置安全码",
            setupCodeHint: "6 位数字，防止他人查看聊天记录",
            securityCode: "安全码",
            locked: "已锁定",
            unlocked: "已解锁",
            autoLock: "超时 {duration} 自动锁定",
            minutes: "{count} 分钟",
            hours: "{count} 小时",
            micTest: "麦克风检测",
            micTestHint: "检查麦克风权限和设备是否正常",
            cameraTest: "摄像头检测",
            cameraTestHint: "检查摄像头权限和画面是否正常",
            language: "语言",
            languageHint: "选择应用显示语言",
            languageTitle: "选择语言",
            chinese: "中文（简体）",
            english: "English",
            deleteAccount: "注销账号",
            deleteAccountHint: "将删除账号信息及所有好友关系，不可恢复",
            checkingUpdate: "检查更新中…",
            latest: "✅ 已是最新版本",
            outdated: "🔔 有新版本 v{version}，点击更新",
            checkFailed: "无法检查更新",
        },
    },
    "en-US": {
        common: { close: "Close" },
        nav: { chats: "Chats", friends: "Friends", games: "Games", profile: "Me" },
        header: {
            app: "MiChat",
            chat: "Chat",
            friends: "Friends",
            games: "Blockchain Games",
            profile: "My Profile",
            lockNow: "Lock now",
            refresh: "Reconnect",
            disconnected: "Connection lost. Reconnecting...",
            reconnected: "Reconnected",
            locked: "Locked",
        },
        update: {
            required: "Update required",
            requiredMessage: "Version v{version} is no longer supported. Please update to continue.",
            updateNow: "Update now",
        },
        profile: {
            editNickname: "Edit nickname",
            myId: "My ID",
            copyId: "Copy my Chat ID: {id}",
            shareId: "Share it with friends so they can add you",
            inviteFriend: "Invite friends",
            inviteHint: "Create a link that adds you after your friend signs up",
            backupKey: "Back up private key",
            backupWarning: "Important: back up before clearing browser data",
            setupCode: "Set security code",
            setupCodeHint: "Use 6 digits to protect your chat history",
            securityCode: "Security code",
            locked: "Locked",
            unlocked: "Unlocked",
            autoLock: "Auto-lock after {duration}",
            minutes: "{count} min",
            hours: "{count} hr",
            micTest: "Microphone test",
            micTestHint: "Check microphone permission and device status",
            cameraTest: "Camera test",
            cameraTestHint: "Check camera permission and video preview",
            language: "Language",
            languageHint: "Choose the app display language",
            languageTitle: "Choose language",
            chinese: "中文（简体）",
            english: "English",
            deleteAccount: "Delete account",
            deleteAccountHint: "Permanently delete your account and all friend connections",
            checkingUpdate: "Checking for updates…",
            latest: "✅ You're up to date",
            outdated: "🔔 Version {version} is available — update now",
            checkFailed: "Unable to check for updates",
        },
    },
};

function initialLocale() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (SUPPORTED_LOCALES.includes(saved)) return saved;
    } catch {
        // Storage can be unavailable in privacy-restricted webviews.
    }
    return "en-US";
}

const locale = ref(initialLocale());

function lookup(key) {
    return key.split(".").reduce((value, part) => value?.[part], messages[locale.value]);
}

export function t(key, params = {}) {
    const value = lookup(key) ?? key;
    return Object.entries(params).reduce(
        (text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)),
        value,
    );
}

export function setLocale(value) {
    if (!SUPPORTED_LOCALES.includes(value)) return;
    locale.value = value;
    document.documentElement.lang = value;
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Keep the in-memory selection if storage is unavailable.
    }
}

document.documentElement.lang = locale.value;

export function useI18n() {
    return {
        locale: readonly(locale),
        isEnglish: computed(() => locale.value === "en-US"),
        locales: SUPPORTED_LOCALES,
        setLocale,
        t,
    };
}
