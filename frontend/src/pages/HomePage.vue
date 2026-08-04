<template>
    <div class="home-page">
        <!-- Hero Section -->
        <section class="hero">
            <div class="hero-content">
                <img
                    :src="logoUrl"
                    alt="Yunmi"
                    width="120"
                    style="border-radius: 20px"
                />
                <div class="hero-title">Yunmi</div>
                <!-- <div style="margin: 0 0 16px 0">Only for privacy and security</div>
                <p class="hero-subtitle">
                    Based on privatized secure communication architecture + Built with end-to-end encryption，Strictly adhere to the minimum data principle，Strictly control data flow boundaries。
                    Core communication data is only retained on the user’s local device，The server is only responsible for secure forwarding，Prevent third-party snooping、Data leakage and illegal scraping，Private information is controlled only by the communicating parties。
                </p> -->
                <q-btn
                    unelevated
                    color="primary"
                    size="lg"
                    :label="identity.isReady ? 'enter' : 'Get invitation code'"
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
            <h2 class="section-title">core competencies</h2>
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
                        <h3 class="capability-title">End-to-end secure encryption（E2EE）</h3>
                        <p class="capability-desc">
                            Use modern cryptographic protocols（ECDH key exchange + AES-256-GCM Strong encryption），Single message independent session key，Fully encrypted transmission。
                            Only the sending and receiving parties can decrypt and view it.，Effectively resist packet capture、eavesdrop、Data theft and other risks。
                        </p>
                    </div>
                </div>
                <div class="capability-item">
                    <div class="capability-icon">
                        <q-icon name="cloud_off" size="32px" color="primary" />
                    </div>
                    <div class="capability-content">
                        <h3 class="capability-title">Minimalist and lightweight service architecture</h3>
                        <p class="capability-desc">
                            The server only participates in message forwarding，No readable data is stored，Do not record user behavior logs，Minimize data exposure。
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
                        <h3 class="capability-title">Secure transfer of encrypted files</h3>
                        <p class="capability-desc">
                            All types of documents are encrypted and transferred throughout the process，transmission、Temporary cache full link protection，Prevent leakage of sensitive documents。
                        </p>
                    </div>
                </div>
                <div class="capability-item">
                    <div class="capability-icon">
                        <q-icon name="timer" size="32px" color="orange" />
                    </div>
                    <div class="capability-content">
                        <h3 class="capability-title">Burn after reading Traceless communication</h3>
                        <p class="capability-desc">
                            Customize message destruction time limit，Automatically clean up after reading，Leave no long-lasting traces on your device or network。
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
                        <h3 class="capability-title">Screen capture protection Risk reminder</h3>
                        <p class="capability-desc">
                            Multi-terminal adaptation privacy protection mechanism，Supports screenshot behavior detection and risk reminders，Protect session privacy in multiple dimensions。<span
                                class="capability-note"
                                >（※ Different systems have different capabilities）</span
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
                        <h3 class="capability-title">Pure tracking-free experience</h3>
                        <p class="capability-desc">
                            No advertising push、No user portrait collection、No background behavior tracking；Encrypted private key local independent storage，Fully protect user data autonomy。
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
            <h2 class="section-title">Core features</h2>
            <div class="features-grid">
                <q-card class="feature-card">
                    <q-card-section class="text-center">
                        <q-icon
                            name="enhanced_encryption"
                            size="48px"
                            color="primary"
                            class="q-mb-md"
                        />
                        <div class="text-h6 q-mb-sm">Military-grade encryption standards</div>
                        <div class="text-body2 text-grey">
                            P-256 Elliptic Curve Key Agreement + High-order symmetric encryption，Paired with dynamic session key updates，Strengthen forward security protection
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
                        <div class="text-h6 q-mb-sm">Autonomous message control</div>
                        <div class="text-body2 text-grey">
                            Support message editing、Withdraw、destroy，The user controls the entire session content
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
                        <div class="text-h6 q-mb-sm">Privacy first architecture</div>
                        <div class="text-body2 text-grey">
                            Followed from the beginning of the design“minimal data principle”：Do not collect、No analysis、Not stored。
                        </div>
                    </q-card-section>
                </q-card>
            </div>
        </section> -->

        <!-- How It Works Section -->
        <!-- <section class="how-it-works">
            <h2 class="section-title">How to use</h2>
            <div class="steps">
                <div class="step">
                    <div class="step-number">1</div>
                    <div class="step-content">
                        <div class="text-h6 q-mb-sm">Invite admission</div>
                        <div class="text-body2 text-grey">
                            Complete registration via exclusive invitation link，Protect the privacy environment of the community
                        </div>
                    </div>
                </div>
                <div class="step">
                    <div class="step-number">2</div>
                    <div class="step-content">
                        <div class="text-h6 q-mb-sm">secure identity</div>
                        <div class="text-body2 text-grey">
                            Automatically generate exclusive encrypted identities and unique Chat ID，Private key local storage，No leakage、Do not upload
                        </div>
                    </div>
                </div>
                <div class="step">
                    <div class="step-number">3</div>
                    <div class="step-content">
                        <div class="text-h6 q-mb-sm">private communication</div>
                        <div class="text-body2 text-grey">
                            Add friends to start an encrypted session，Full privacy protection，Safe Chat
                        </div>
                    </div>
                </div>
            </div>
        </section> -->

        <!-- Download Section -->
        <!-- <section class="download-section">
            <h2 class="section-title">Download now</h2>
            <p class="download-subtitle">Multi-terminal synchronization，Secure communication anytime, anywhere</p>
            <div class="download-grid">
                <div class="download-card">
                    <div class="download-icon windows-icon">
                        <svg viewBox="0 0 24 24" width="36" height="36" fill="white"><path d="M3 12V6.75l6-1.32v6.57H3zm17-9v8.75h-7V3.69L20 3zM3 13h6v6.57l-6-1.32V13zm17 .25V22l-7-1.31V13.25H20z"/></svg>
                    </div>
                    <div class="download-platform">Windows</div>
                    <div class="download-desc">Applicable to Windows 10 and above</div>
                    <q-btn unelevated color="primary" class="download-btn" icon="download" label="Download .exe" :disable="!downloadUrls.windows" @click="downloadFile(downloadUrls.windows)" />
                </div>

                <div class="download-card">
                    <div class="download-icon android-icon">
                        <q-icon name="android" size="36px" color="white" />
                    </div>
                    <div class="download-platform">Android</div>
                    <div class="download-desc">Applicable to Android 7.0 and above</div>
                    <q-btn unelevated color="positive" class="download-btn" icon="download" label="Download .apk" :disable="!downloadUrls.apk" @click="downloadFile(downloadUrls.apk)" />
                </div>

                <div class="download-card ios-unavailable">
                    <div class="download-icon ios-icon">
                        <svg viewBox="0 0 24 24" width="36" height="36" fill="white"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                    </div>
                    <div class="download-platform">
                        iOS
                        <q-badge color="orange" label="Not supported yet" class="q-ml-xs" style="vertical-align: middle" />
                    </div>
                    <div class="download-desc">iPhone / iPad</div>
                    <q-btn unelevated color="grey-5" class="download-btn" icon="info" label="Instructions for use" @click="showIosDialog = true" />
                </div>

                <div class="download-card ios-unavailable">
                    <div class="download-icon mac-icon">
                        <svg viewBox="0 0 24 24" width="36" height="36" fill="white"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                    </div>
                    <div class="download-platform">
                        macOS
                        <q-badge color="orange" label="Not supported yet" class="q-ml-xs" style="vertical-align: middle" />
                    </div>
                    <div class="download-desc">Please use your browser to access the web version</div>
                    <q-btn unelevated color="grey-5" class="download-btn" icon="language" label="Open web page" @click="openWebVersion" />
                </div>
            </div>
        </section> -->

        <!-- Footer -->
        <!-- <footer class="footer">
            <div class="footer-content">
                <div class="text-subtitle2">Yunmi - Just for safety</div>
                <div class="text-caption text-grey q-mt-sm">
                    Designed based on end-to-end encryption and zero-trust architecture，Ensure all data exists only on user devices
                </div>
            </div>
        </footer> -->

        <!-- iOS user guide pop-up window -->
        <!-- <q-dialog v-model="showIosDialog">
            <q-card style="min-width: 320px; max-width: 420px">
                <q-card-section class="row items-center q-pb-none">
                    <div class="text-h6">iOS Usage</div>
                    <q-space />
                    <q-btn icon="close" flat round dense v-close-popup />
                </q-card-section>
                <q-card-section>
                    <div class="text-body2 text-grey q-mb-md">
                        Yunmi is currently not available iOS native application，But you can pass Safari Browser adds web version to home screen，Get an experience close to native apps。
                    </div>
                    <div class="ios-steps">
                        <div class="ios-step">
                            <div class="ios-step-num">1</div>
                            <div>
                                <div class="ios-step-title">use Safari Open website</div>
                                <div class="ios-step-desc text-grey">Please make sure to use <strong>Safari</strong> Browser，Other browsers do not support this feature</div>
                            </div>
                        </div>
                        <div class="ios-step">
                            <div class="ios-step-num">2</div>
                            <div>
                                <div class="ios-step-title">Click the share button at the bottom</div>
                                <div class="ios-step-desc text-grey">Click Safari in the middle of the bottom toolbar <strong>Share</strong> icon（box with arrow）</div>
                            </div>
                        </div>
                        <div class="ios-step">
                            <div class="ios-step-num">3</div>
                            <div>
                                <div class="ios-step-title">Add to home screen</div>
                                <div class="ios-step-desc text-grey">Scroll down in the popup menu，Choose <strong>Add to home screen</strong>，Then click on the upper right corner"add"</div>
                            </div>
                        </div>
                    </div>
                    <q-banner dense rounded class="bg-orange-1 text-orange-9 q-mt-md" style="font-size: 13px">
                        <template #avatar><q-icon name="info" /></template>
                        Once added, it can be opened directly from the home screen，Support full screen display，Experience closer to native App
                    </q-banner>
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="Got it" color="primary" v-close-popup />
                </q-card-actions>
            </q-card>
        </q-dialog> -->

        <!-- Get invitation code dialog box -->
        <q-dialog v-model="showInviteDialog">
            <q-card style="min-width: 320px">
                <q-card-section>
                    <div class="text-h6">Get invitation code</div>
                    <div class="text-body2 text-grey q-mb-md">
                        Yunmi adopts invitation-based registration，Please get the invitation link from an existing user。
                    </div>
                    <div class="text-caption text-grey q-mb-md">
                        Already have an account？
                        <q-btn
                            flat
                            dense
                            color="primary"
                            label="restore identity"
                            @click="goToInit"
                        />
                    </div>
                </q-card-section>
                <q-card-actions align="right">
                    <q-btn flat label="close" v-close-popup />
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
    // Logged-in users automatically jump to the chat page without manually clicking "Enter"
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

/* iOS step styles */
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
