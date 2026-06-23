<template>
    <div class="home-page">
        <!-- Hero Section -->
        <section class="hero">
            <div class="hero-content">
                <img
                    :src="logoUrl"
                    alt="云密"
                    width="120"
                    style="border-radius: 20px"
                />
                <div class="hero-title">云密</div>
                <!-- <div style="margin: 0 0 16px 0">只为隐私安全而生</div>
                <p class="hero-subtitle">
                    基于私有化安全通信架构 + 端到端加密打造，严守最小数据原则，严控数据流转边界。
                    核心通信数据仅留存于用户本地设备，服务端仅负责安全转发，杜绝第三方窥探、数据泄露与非法抓取，私密信息仅由通信双方掌控。
                </p> -->
                <q-btn
                    unelevated
                    color="primary"
                    size="lg"
                    :label="identity.isReady ? '进入' : '获取邀请码'"
                    class="hero-btn"
                    @click="
                        identity.isReady
                            ? goToChats()
                            : (showInviteDialog = true)
                    "
                />
            </div>
        </section>

        <!-- Core Capabilities Section -->
        <!-- <section class="core-capabilities">
            <h2 class="section-title">核心能力</h2>
            <div class="capabilities-list">
                <div class="capability-item">
                    <div class="capability-icon">
                        <q-icon
                            name="enhanced_encryption"
                            size="32px"
                            color="primary"
                        />
                    </div>
                    <div class="capability-content">
                        <h3 class="capability-title">端到端安全加密（E2EE）</h3>
                        <p class="capability-desc">
                            采用现代密码学协议（ECDH 密钥交换 + AES-256-GCM 高强度加密），单条消息独立会话密钥，全程加密传输。
                            仅收发双方可解密查看，有效抵御抓包、窃听、数据窃取等风险。
                        </p>
                    </div>
                </div>
                <div class="capability-item">
                    <div class="capability-icon">
                        <q-icon name="cloud_off" size="32px" color="primary" />
                    </div>
                    <div class="capability-content">
                        <h3 class="capability-title">极简轻量化服务架构</h3>
                        <p class="capability-desc">
                            服务器仅参与消息转发，不存储可读数据，不记录用户行为日志，最大限度缩小数据暴露范围。
                        </p>
                    </div>
                </div>
                <div class="capability-item">
                    <div class="capability-icon">
                        <q-icon
                            name="attach_file"
                            size="32px"
                            color="primary"
                        />
                    </div>
                    <div class="capability-content">
                        <h3 class="capability-title">加密文件安全传输</h3>
                        <p class="capability-desc">
                            各类文件全程加密流转，传输、临时缓存全链路保护，杜绝敏感文件外泄。
                        </p>
                    </div>
                </div>
                <div class="capability-item">
                    <div class="capability-icon">
                        <q-icon name="timer" size="32px" color="orange" />
                    </div>
                    <div class="capability-content">
                        <h3 class="capability-title">阅后即焚 无痕沟通</h3>
                        <p class="capability-desc">
                            自定义消息销毁时效，阅读后自动清理，不在设备或网络中留下长期痕迹。
                        </p>
                    </div>
                </div>
                <div class="capability-item">
                    <div class="capability-icon">
                        <q-icon
                            name="no_photography"
                            size="32px"
                            color="deep-orange"
                        />
                    </div>
                    <div class="capability-content">
                        <h3 class="capability-title">截屏防护 风险提醒</h3>
                        <p class="capability-desc">
                            多终端适配隐私防护机制，支持截屏行为检测与风险提醒，多维度守护会话隐私。<span
                                class="capability-note"
                                >（※ 不同系统能力存在差异）</span
                            >
                        </p>
                    </div>
                </div>
                <div class="capability-item">
                    <div class="capability-icon">
                        <q-icon
                            name="explore_off"
                            size="32px"
                            color="positive"
                        />
                    </div>
                    <div class="capability-content">
                        <h3 class="capability-title">纯净无追踪体验</h3>
                        <p class="capability-desc">
                            无广告推送、无用户画像采集、无后台行为追踪；加密私钥本地独立存储，充分保障用户数据自主权。
                        </p>
                    </div>
                </div>
            </div>
        </section> -->
        <!-- Features Section -->
        <!-- <section
            class="features"
            style="background-color: #f5f7fa; overflow: hidden"
        >
            <h2 class="section-title">核心特性</h2>
            <div class="features-grid">
                <q-card class="feature-card">
                    <q-card-section class="text-center">
                        <q-icon
                            name="enhanced_encryption"
                            size="48px"
                            color="primary"
                            class="q-mb-md"
                        />
                        <div class="text-h6 q-mb-sm">军工级加密标准</div>
                        <div class="text-body2 text-grey">
                            P-256 椭圆曲线密钥协商 + 高阶对称加密，搭配动态会话密钥更新，强化前向安全防护
                        </div>
                    </q-card-section>
                </q-card>

                <q-card class="feature-card">
                    <q-card-section class="text-center">
                        <q-icon
                            name="auto_delete"
                            size="48px"
                            color="orange"
                            class="q-mb-md"
                        />
                        <div class="text-h6 q-mb-sm">消息自主管控</div>
                        <div class="text-body2 text-grey">
                            支持消息编辑、撤回、销毁，全程由用户自主掌控会话内容
                        </div>
                    </q-card-section>
                </q-card>

                <q-card class="feature-card">
                    <q-card-section class="text-center">
                        <q-icon
                            name="no_photography"
                            size="48px"
                            color="deep-orange"
                            class="q-mb-md"
                        />
                        <div class="text-h6 q-mb-sm">隐私优先架构</div>
                        <div class="text-body2 text-grey">
                            从设计之初即遵循“最小数据原则”：不收集、不分析、不存储。
                        </div>
                    </q-card-section>
                </q-card>
            </div>
        </section> -->

        <!-- How It Works Section -->
        <!-- <section class="how-it-works">
            <h2 class="section-title">如何使用</h2>
            <div class="steps">
                <div class="step">
                    <div class="step-number">1</div>
                    <div class="step-content">
                        <div class="text-h6 q-mb-sm">邀请准入</div>
                        <div class="text-body2 text-grey">
                            通过专属邀请链接完成注册，保障社群私密环境
                        </div>
                    </div>
                </div>
                <div class="step">
                    <div class="step-number">2</div>
                    <div class="step-content">
                        <div class="text-h6 q-mb-sm">安全身份</div>
                        <div class="text-body2 text-grey">
                            自动生成专属加密身份与唯一 Chat ID，私钥本地封存，不外流、不上传
                        </div>
                    </div>
                </div>
                <div class="step">
                    <div class="step-number">3</div>
                    <div class="step-content">
                        <div class="text-h6 q-mb-sm">私密沟通</div>
                        <div class="text-body2 text-grey">
                            添加好友即可开启加密会话，全程隐私防护，安全聊天
                        </div>
                    </div>
                </div>
            </div>
        </section> -->

        <!-- Download Section -->
        <!-- <section class="download-section">
            <h2 class="section-title">立即下载</h2>
            <p class="download-subtitle">多端同步，随时随地安全通信</p>
            <div class="download-grid">
                <div class="download-card">
                    <div class="download-icon windows-icon">
                        <svg viewBox="0 0 24 24" width="36" height="36" fill="white"><path d="M3 12V6.75l6-1.32v6.57H3zm17-9v8.75h-7V3.69L20 3zM3 13h6v6.57l-6-1.32V13zm17 .25V22l-7-1.31V13.25H20z"/></svg>
                    </div>
                    <div class="download-platform">Windows</div>
                    <div class="download-desc">适用于 Windows 10 及以上</div>
                    <q-btn unelevated color="primary" class="download-btn" icon="download" label="下载 .exe" :disable="!downloadUrls.windows" @click="downloadFile(downloadUrls.windows)" />
                </div>

                <div class="download-card">
                    <div class="download-icon android-icon">
                        <q-icon name="android" size="36px" color="white" />
                    </div>
                    <div class="download-platform">Android</div>
                    <div class="download-desc">适用于 Android 7.0 及以上</div>
                    <q-btn unelevated color="positive" class="download-btn" icon="download" label="下载 .apk" :disable="!downloadUrls.apk" @click="downloadFile(downloadUrls.apk)" />
                </div>

                <div class="download-card ios-unavailable">
                    <div class="download-icon ios-icon">
                        <svg viewBox="0 0 24 24" width="36" height="36" fill="white"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                    </div>
                    <div class="download-platform">
                        iOS
                        <q-badge color="orange" label="暂不支持" class="q-ml-xs" style="vertical-align: middle" />
                    </div>
                    <div class="download-desc">iPhone / iPad</div>
                    <q-btn unelevated color="grey-5" class="download-btn" icon="info" label="使用说明" @click="showIosDialog = true" />
                </div>

                <div class="download-card ios-unavailable">
                    <div class="download-icon mac-icon">
                        <svg viewBox="0 0 24 24" width="36" height="36" fill="white"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                    </div>
                    <div class="download-platform">
                        macOS
                        <q-badge color="orange" label="暂不支持" class="q-ml-xs" style="vertical-align: middle" />
                    </div>
                    <div class="download-desc">请使用浏览器访问网页版</div>
                    <q-btn unelevated color="grey-5" class="download-btn" icon="language" label="打开网页" @click="openWebVersion" />
                </div>
            </div>
        </section> -->

        <!-- Footer -->
        <!-- <footer class="footer">
            <div class="footer-content">
                <div class="text-subtitle2">云密 - 只为安全而生</div>
                <div class="text-caption text-grey q-mt-sm">
                    基于端到端加密与零信任架构设计，确保所有数据仅存在于用户设备中
                </div>
            </div>
        </footer> -->

        <!-- iOS 使用说明弹窗 -->
        <!-- <q-dialog v-model="showIosDialog">
            <q-card style="min-width: 320px; max-width: 420px">
                <q-card-section class="row items-center q-pb-none">
                    <div class="text-h6">iOS 使用方式</div>
                    <q-space />
                    <q-btn icon="close" flat round dense v-close-popup />
                </q-card-section>
                <q-card-section>
                    <div class="text-body2 text-grey q-mb-md">
                        云密目前暂不提供 iOS 原生应用，但您可以通过 Safari 浏览器将网页版添加到主屏幕，获得接近原生应用的体验。
                    </div>
                    <div class="ios-steps">
                        <div class="ios-step">
                            <div class="ios-step-num">1</div>
                            <div>
                                <div class="ios-step-title">用 Safari 打开网站</div>
                                <div class="ios-step-desc text-grey">请确保使用 <strong>Safari</strong> 浏览器，其他浏览器不支持此功能</div>
                            </div>
                        </div>
                        <div class="ios-step">
                            <div class="ios-step-num">2</div>
                            <div>
                                <div class="ios-step-title">点击底部分享按钮</div>
                                <div class="ios-step-desc text-grey">点击 Safari 底部工具栏中间的 <strong>分享</strong> 图标（方框加箭头）</div>
                            </div>
                        </div>
                        <div class="ios-step">
                            <div class="ios-step-num">3</div>
                            <div>
                                <div class="ios-step-title">添加到主屏幕</div>
                                <div class="ios-step-desc text-grey">在弹出菜单中向下滚动，选择 <strong>添加到主屏幕</strong>，然后点击右上角"添加"</div>
                            </div>
                        </div>
                    </div>
                    <q-banner dense rounded class="bg-orange-1 text-orange-9 q-mt-md" style="font-size: 13px">
                        <template #avatar><q-icon name="info" /></template>
                        添加后可从主屏幕直接打开，支持全屏显示，体验更接近原生 App
                    </q-banner>
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="知道了" color="primary" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog> -->

        <!-- 获取邀请码对话框 -->
        <q-dialog v-model="showInviteDialog">
            <q-card style="min-width: 320px">
                <q-card-section>
                    <div class="text-h6">获取邀请码</div>
                    <div class="text-body2 text-grey q-mb-md">
                        云密采用邀请制注册，请从已有用户处获取邀请链接。
                    </div>
                    <div class="text-caption text-grey q-mb-md">
                        已有账号？
                        <q-btn
                            flat
                            dense
                            color="primary"
                            label="恢复身份"
                            @click="goToInit"
                        />
                    </div>
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="关闭" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog>
    </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useIdentityStore } from "src/stores/identity";

const router = useRouter();
const identity = useIdentityStore();
const showInviteDialog = ref(false);
const showIosDialog = ref(false);

function openWebVersion() {
    window.open('https://yb.yzs88.com', '_blank');
}
import logoUrl from "src/assets/logo.png";

const downloadUrls = {
    windows: 'https://yb.yzs88.com/download/yunChat.exe',
    apk: 'https://yb.yzs88.com/download/yunChat.apk',
};

function downloadFile(url) {
    if (!url) return;
    window.location.href = url;
}

onMounted(async () => {
    // 已登录用户自动跳转到聊天页面，无需手动点击"进入"
    if (identity.isReady) {
        router.replace("/chats");
    }
});

function goToInit() {
    showInviteDialog.value = false;
    router.push("/init");
}

function goToChats() {
    router.push("/chats");
}
</script>

<style scoped>
.home-page {
    min-height: 100vh;
    background: linear-gradient(180deg, #f5f7fa 0%, #e4e8ed 100%);
}

.hero {
    padding: 60px 20px;
    text-align: center;
    background: white;
}

.hero-content {
    max-width: 600px;
    margin: 0 auto;
}

.logo-icon {
    width: 120px;
    height: 120px;
    margin: 0 auto 24px;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #1976d2 0%, #1565c0 100%);
    border-radius: 24px;
    box-shadow: 0 8px 24px rgba(25, 118, 210, 0.3);
}

.logo-cloud {
    opacity: 0.3;
}

.logo-lock {
    position: absolute;
}

.hero-icon {
    margin-bottom: 20px;
}

.hero-title {
    font-size: 48px;
    font-weight: 700;
    color: #1976d2;
}

.hero-subtitle {
    font-size: 18px;
    color: #666;
    margin-bottom: 32px;
}

.hero-quick-features {
    display: flex;
    justify-content: center;
    gap: 20px;
    margin-top: 24px;
    flex-wrap: wrap;
}

.quick-feature {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #555;
    font-size: 14px;
}

.hero-btn {
    padding: 12px 32px;
}

/* Core Capabilities Section */
.core-capabilities {
    padding: 60px 20px;
    background: #f5f7fa;
}

.capabilities-list {
    max-width: 800px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 24px;
}

.capability-item {
    display: flex;
    align-items: flex-start;
    gap: 20px;
    padding: 24px;
    background: #f8f9fa;
    border-radius: 12px;
    transition: box-shadow 0.75s ease;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.capability-item:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.38);
}

.capability-icon {
    flex-shrink: 0;
    width: 56px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: white;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.capability-content {
    flex: 1;
}

.capability-title {
    font-size: 18px;
    font-weight: 600;
    color: #333;
    margin: 0 0 8px 0;
}

.capability-desc {
    font-size: 15px;
    color: #666;
    margin: 0;
    line-height: 1.6;
}

.capability-note {
    color: #999;
    font-size: 13px;
}

.section-title {
    font-size: 28px;
    font-weight: 600;
    text-align: center;
    color: #333;
    margin-bottom: 40px;
}

.how-it-works {
    padding: 60px 20px;
    background: white;
}

.steps {
    max-width: 600px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 32px;
}

.step {
    display: flex;
    align-items: flex-start;
    gap: 20px;
}

.step-number {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #1976d2;
    color: white;
    font-size: 24px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.step-content {
    flex: 1;
}

.download-section {
    padding: 60px 20px;
    background: white;
    text-align: center;
}

.download-subtitle {
    color: #666;
    margin: -24px 0 40px;
    font-size: 15px;
}

.download-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    max-width: 900px;
    margin: 0 auto;
}

.download-card {
    background: #f8f9fa;
    border-radius: 16px;
    padding: 28px 20px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
    transition: box-shadow 0.2s;
}

.download-card:hover {
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
}

.ios-unavailable {
    opacity: 0.75;
}

.download-icon {
    width: 68px;
    height: 68px;
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 4px;
}

.windows-icon { background: linear-gradient(135deg, #0078d4, #005fa3); }
.mac-icon     { background: linear-gradient(135deg, #555, #333); }
.android-icon { background: linear-gradient(135deg, #3ddc84, #22a45b); }
.ios-icon     { background: linear-gradient(135deg, #888, #555); }

.download-platform {
    font-size: 18px;
    font-weight: 600;
    color: #222;
}

.download-desc {
    font-size: 13px;
    color: #888;
    margin-bottom: 4px;
}

.download-btn-link {
    text-decoration: none;
    width: 100%;
    display: flex;
    justify-content: center;
}

.download-btn-link.disabled {
    pointer-events: none;
}

.download-btn {
    width: 100%;
    border-radius: 8px;
}

/* iOS 步骤样式 */
.ios-steps {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.ios-step {
    display: flex;
    align-items: flex-start;
    gap: 14px;
}

.ios-step-num {
    min-width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #1976d2;
    color: white;
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 2px;
}

.ios-step-title {
    font-weight: 600;
    font-size: 14px;
    color: #333;
    margin-bottom: 2px;
}

.ios-step-desc {
    font-size: 13px;
    line-height: 1.5;
}

.footer {
    padding: 40px 20px;
    text-align: center;
    background: #f5f7fa;
}

.footer-content {
    max-width: 400px;
    margin: 0 auto;
}

.features-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 20px;
    padding: 0 20px 60px;
}

.feature-card {
    border-radius: 12px;
}

@media (max-width: 600px) {
    .hero-title {
        font-size: 36px;
    }

    .hero-quick-features {
        gap: 12px;
    }

    .quick-feature {
        font-size: 12px;
    }

    .capability-item {
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 20px;
    }

    .capability-title {
        font-size: 16px;
    }

    .capability-desc {
        font-size: 14px;
    }
    .feature-item {
        font-size: 14px;
    }

    .features-grid {
        grid-template-columns: 1fr;
    }

    .download-grid {
        grid-template-columns: repeat(2, 1fr);
    }
}
</style>
