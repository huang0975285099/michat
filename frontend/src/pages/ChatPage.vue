<template>
  <q-page ref="pageEl" class="column">
    <!-- Top friend information -->
    <div class="chat-peer-bar row items-center q-px-sm q-py-xs q-gutter-sm">
      <deterministic-avatar :seed="friendChatId" :size="32" />
      <div class="col chat-peer-identity">
        <div class="chat-peer-name">{{ friendNickname }}</div>
        <div class="chat-peer-id">{{ friendChatId }}</div>
      </div>
      <q-icon name="circle" :color="friendOnline ? 'positive' : 'grey-4'" size="12px">
        <q-tooltip>{{ friendOnline ? t("common.online") : t("common.offline") }}</q-tooltip>
      </q-icon>
      <q-btn
        flat round dense icon="call" color="grey-7"
        :disable="callStore.state !== 'idle'"
        @click="callStore.startCall(friendChatId, friendNickname, 'audio')"
      >
        <q-tooltip>{{ t("call.voice") }}</q-tooltip>
      </q-btn>
      <q-btn
        flat round dense icon="videocam" color="grey-7"
        :disable="callStore.state !== 'idle'"
        @click="callStore.startCall(friendChatId, friendNickname, 'video')"
      >
        <q-tooltip>{{ t("call.video") }}</q-tooltip>
      </q-btn>
      <!-- <q-btn flat round dense icon="more_vert">
        <q-menu anchor="bottom right" self="top right">
          <q-list dense style="min-width: 140px">
            <q-item clickable v-close-popup @click="clearHistory" class="text-negative items-center q-gutter-xs">
              <q-icon name="delete_sweep" size="sm" />
              <span>Clear chat history</span>
            </q-item>
          </q-list>
        </q-menu>
      </q-btn> -->
    </div>

    <!-- Message list (virtual scrolling: only render messages within the viewport, long history remains smooth) -->
    <div class="chat-message-area col">
      <div
        class="chat-watermark"
        :class="{ 'chat-watermark-burn': burnMode }"
        aria-hidden="true"
      >
        <span v-for="index in 48" :key="index">{{ watermarkText }}</span>
      </div>
      <q-virtual-scroll
        ref="virtualScrollEl"
        :items="messages"
        :virtual-scroll-item-size="60"
        class="chat-message-scroll q-px-sm q-py-md"
        :style="{ overflowAnchor: 'none', opacity: scrolled ? 1 : 0, transition: 'opacity 0.08s' }"
        v-slot="{ item: msg, index: idx }"
      >
      <div
        :key="msg.id"
        class="row items-end"
        :class="[
          msg.mine ? 'justify-end' : 'justify-start',
          { 'message-target-highlight': highlightedMessageId === msg.id },
        ]"
        :style="{ paddingTop: shouldCompact(messages, idx) ? '2px' : '8px' }"
      >
        <!-- Message from the other party: The avatar is on the left -->
        <template v-if="!msg.mine">
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="friendChatId" :size="28" class="avatar-side q-mr-xs" />
          <div v-else class="avatar-placeholder" />
          <div class="q-pa-sm bubble-theirs" :class="{ 'bubble-burn': msg.burnAfterRead }">
            <button
              v-if="msg.reply"
              type="button"
              class="message-reply-quote message-reply-quote-theirs"
              @click.stop="scrollToRepliedMessage(msg.reply)"
            >
              <span class="message-reply-author">{{ replySenderName(msg.reply) }}</span>
              <span class="message-reply-preview">{{ replyPreviewText(msg.reply) }}</span>
            </button>
            <!-- file message -->
            <template v-if="msg.type === 'file'">
              <button
                v-if="isMsgVoice(msg)"
                type="button"
                class="voice-message voice-message-theirs"
                :disabled="!msg.objectUrl"
                @click="toggleVoicePlayback(msg)"
              >
                <q-icon :name="playingVoiceId === msg.id ? 'pause' : 'play_arrow'" size="22px" />
                <span class="voice-message-wave">▂▄▆▃▇▅▂▄▆</span>
                <span>{{ formatVoiceDuration(msg.durationMs) }}</span>
              </button>
              <img
                v-else-if="isMsgImage(msg) && msg.objectUrl"
                :src="msg.objectUrl"
                :alt="msg.filename || t('chat.imageMessage')"
                class="file-img"
                @load="onMessageImageSettled(msg, idx)"
                @error="onMessageImageSettled(msg, idx)"
                @click="openImagePreview(msg)"
              />
              <video v-else-if="isMsgVideo(msg) && msg.objectUrl" :src="msg.objectUrl" controls class="file-video" />
              <div v-else class="file-card file-card-theirs">
                <span class="file-icon">{{ getFileIcon(msg.filetype, msg.filename) }}</span>
                <div class="file-meta">
                  <div class="file-name">{{ msg.filename }}</div>
                  <div class="file-size">{{ formatFileSize(msg.filesize) }}</div>
                  <div v-if="fileDownloadState(msg)" class="file-download-status">
                    <q-linear-progress
                      v-if="isFileDownloading(msg)"
                      :value="fileDownloadProgress(msg) / 100"
                      rounded
                      color="primary"
                      class="file-download-progress"
                    />
                    <span>{{ fileDownloadStatusText(msg) }}</span>
                  </div>
                </div>
                <button
                  v-if="msg.objectUrl || msg.localFileAvailable"
                  type="button"
                  class="file-dl"
                  :class="{ complete: fileDownloadState(msg)?.status === 'done' }"
                  :disabled="isFileDownloading(msg)"
                  @click.stop="downloadFile(msg)"
                >
                  <q-icon :name="fileDownloadIcon(msg)" size="20px" />
                  <q-tooltip>{{ fileDownloadTooltip(msg) }}</q-tooltip>
                </button>
                <span v-else class="file-expired">{{ t("chat.expired") }}</span>
              </div>
            </template>
            <!-- Ordinary text message -->
            <template v-else>
              <div>{{ msg.decryptionFailed || msg.text === '[Decryption failed]' ? t("chat.decryptionFailed") : msg.text }}</div>
            </template>
            <div class="text-caption q-mt-xs text-grey row items-center q-gutter-xs">
              <span>{{ formatTime(msg.ts) }}</span>
              <span v-if="msg.type === 'file'">· {{ attachmentStatusText(msg) }}</span>
              <span v-if="msg.burnAfterRead" class="burn-countdown">
                <q-icon name="local_fire_department" size="14px" />
                {{ burnCountdownText(msg) }}
              </span>
            </div>
            <message-action-menu
              :can-reply="canReply(msg)"
              :can-copy="canCopy(msg)"
              :can-delete="canDeleteMessage(msg)"
              :can-recall="false"
              :can-retry="false"
              @reply="startReply(msg)"
              @copy="copyMessage(msg)"
              @delete="deleteMsg(msg)"
            />
          </div>
        </template>

        <!-- My message: Avatar is on the right -->
        <template v-else>
          <div class="q-pa-sm bubble-mine" :class="{ 'bubble-burn': msg.burnAfterRead }">
            <button
              v-if="msg.reply"
              type="button"
              class="message-reply-quote message-reply-quote-mine"
              @click.stop="scrollToRepliedMessage(msg.reply)"
            >
              <span class="message-reply-author">{{ replySenderName(msg.reply) }}</span>
              <span class="message-reply-preview">{{ replyPreviewText(msg.reply) }}</span>
            </button>
            <!-- file message -->
            <template v-if="msg.type === 'file'">
              <button
                v-if="isMsgVoice(msg)"
                type="button"
                class="voice-message voice-message-mine"
                :disabled="!msg.objectUrl"
                @click="toggleVoicePlayback(msg)"
              >
                <q-icon :name="playingVoiceId === msg.id ? 'pause' : 'play_arrow'" size="22px" />
                <span class="voice-message-wave">▂▄▆▃▇▅▂▄▆</span>
                <span>{{ formatVoiceDuration(msg.durationMs) }}</span>
              </button>
              <img
                v-else-if="isMsgImage(msg) && msg.objectUrl"
                :src="msg.objectUrl"
                :alt="msg.filename || t('chat.imageMessage')"
                class="file-img"
                @load="onMessageImageSettled(msg, idx)"
                @error="onMessageImageSettled(msg, idx)"
                @click="openImagePreview(msg)"
              />
              <video v-else-if="isMsgVideo(msg) && msg.objectUrl" :src="msg.objectUrl" controls class="file-video" />
              <div v-else class="file-card file-card-mine">
                <span class="file-icon">{{ getFileIcon(msg.filetype, msg.filename) }}</span>
                <div class="file-meta">
                  <div class="file-name">{{ msg.filename }}</div>
                  <div class="file-size">{{ formatFileSize(msg.filesize) }}</div>
                  <div v-if="fileDownloadState(msg)" class="file-download-status">
                    <q-linear-progress
                      v-if="isFileDownloading(msg)"
                      :value="fileDownloadProgress(msg) / 100"
                      rounded
                      color="white"
                      class="file-download-progress"
                    />
                    <span>{{ fileDownloadStatusText(msg) }}</span>
                  </div>
                </div>
                <button
                  v-if="msg.objectUrl || msg.localFileAvailable"
                  type="button"
                  class="file-dl file-dl-mine"
                  :class="{ complete: fileDownloadState(msg)?.status === 'done' }"
                  :disabled="isFileDownloading(msg)"
                  @click.stop="downloadFile(msg)"
                >
                  <q-icon :name="fileDownloadIcon(msg)" size="20px" />
                  <q-tooltip>{{ fileDownloadTooltip(msg) }}</q-tooltip>
                </button>
                <span v-else class="file-expired">{{ t("chat.expired") }}</span>
              </div>
            </template>
            <!-- Ordinary text message -->
            <template v-else>
              <div>{{ msg.decryptionFailed || msg.text === '[Decryption failed]' ? t("chat.decryptionFailed") : msg.text }}</div>
            </template>
            <div class="text-caption q-mt-xs text-blue-2 row items-center q-gutter-xs">
              <span>{{ formatTime(msg.ts) }}</span>
              <span v-if="msg.type === 'file'">· {{ attachmentStatusText(msg) }}</span>
              <div>
                <q-icon v-if="msg.status === 'pending'" name="schedule" size="13px">
                  <q-tooltip>{{ t("chat.sending") }}</q-tooltip>
                </q-icon>
                <q-icon
                  v-else-if="msg.status === 'queued'"
                  name="cloud_upload"
                  size="14px"
                  class="message-retry-icon"
                  @click.stop="retryMsg(msg)"
                >
                  <q-tooltip>{{ messageFailureText(msg) }}</q-tooltip>
                </q-icon>
                <q-icon
                  v-else-if="msg.status === 'failed'"
                  name="error_outline"
                  size="14px"
                  color="negative"
                  class="message-retry-icon"
                  @click.stop="retryMsg(msg)"
                >
                  <q-tooltip>{{ messageFailureText(msg) }}</q-tooltip>
                </q-icon>
                <q-icon
                  v-else-if="msg.status === 'paused'"
                  name="pause_circle_outline"
                  size="14px"
                  class="message-retry-icon"
                  @click.stop="retryMsg(msg)"
                >
                  <q-tooltip>{{ t("chat.uploadPaused") }}</q-tooltip>
                </q-icon>
                <template v-else>
                  <span v-if="msg.read" class="read-status">✔✔</span>
                  <span v-else class="read-status">✔</span>
                  <q-tooltip v-if="msg.read">{{ t("chat.read") }}</q-tooltip>
                  <q-tooltip v-else>{{ t("chat.delivered") }}</q-tooltip>
                </template>
              </div>
              <span v-if="msg.burnAfterRead" class="burn-countdown burn-countdown-mine">
                <q-icon name="local_fire_department" size="14px" />
                {{ burnCountdownText(msg) }}
              </span>
            </div>
            <message-action-menu
              :can-reply="canReply(msg)"
              :can-copy="canCopy(msg)"
              :can-delete="canDeleteMessage(msg)"
              :can-recall="canRecall(msg)"
              :can-retry="(msg.type !== 'file' || !!msg.offlineAttachment) && (msg.status === 'queued' || msg.status === 'failed' || msg.status === 'paused')"
              :retry-label="msg.status === 'paused' ? t('chat.resumeUpload') : t('chat.resend')"
              @reply="startReply(msg)"
              @copy="copyMessage(msg)"
              @retry="retryMsg(msg)"
              @delete="deleteMsg(msg)"
              @recall="recall(msg)"
            />
          </div>
          <deterministic-avatar v-if="!shouldCompact(messages, idx)" :seed="identityStore.chatId" :size="28" class="avatar-side q-ml-xs" />
          <div v-else class="avatar-placeholder" />
        </template>
      </div>
      </q-virtual-scroll>
    </div>

    <!-- File transfer progress bar (displayed when there is a transfer in progress) -->
    <div v-if="activeTransfer" class="q-px-md q-py-xs bg-blue-1 row items-center q-gutter-sm" style="border-top: 1px solid #bbdefb">
      <q-icon name="attach_file" color="primary" size="18px" />
      <div class="col">
        <div class="text-caption text-grey-8 ellipsis" style="max-width: 200px">{{ activeTransfer.filename }}</div>
        <q-linear-progress
          :value="activeTransfer.progress / 100"
          :indeterminate="activeTransfer.status === 'processing'"
          :color="activeTransfer.status === 'error' ? 'negative' : 'primary'"
          rounded
          style="height: 4px"
        />
      </div>
      <span class="text-caption text-grey-7">
        {{ activeTransferStatusText(activeTransfer) }}
      </span>
      <q-btn
        v-if="activeTransfer.transport === 'offline' && (activeTransfer.status === 'transferring' || activeTransfer.status === 'paused' || (activeTransfer.direction === 'receive' && activeTransfer.status === 'error'))"
        flat
        round
        dense
        size="sm"
        :icon="activeTransfer.status === 'paused' || activeTransfer.status === 'error' ? 'play_arrow' : 'pause'"
        :aria-label="activeTransfer.status === 'paused' || activeTransfer.status === 'error' ? t('chat.resumeTransfer') : t('chat.pauseTransfer')"
        @click="toggleOfflineTransfer(activeTransfer)"
      >
        <q-tooltip>{{ activeTransfer.status === 'paused' || activeTransfer.status === 'error' ? t("chat.resumeTransfer") : t("chat.pauseTransfer") }}</q-tooltip>
      </q-btn>
      <q-btn
        v-if="activeTransfer.transport === 'offline' && ['pending', 'transferring', 'processing', 'paused', 'error'].includes(activeTransfer.status)"
        flat round dense size="sm" icon="close" color="negative"
        :aria-label="t('chat.cancelTransfer')"
        @click="confirmCancelTransfer(activeTransfer)"
      >
        <q-tooltip>{{ t("chat.cancelTransfer") }}</q-tooltip>
      </q-btn>
      <q-icon v-if="activeTransfer.status === 'error'" name="error_outline" color="negative" size="18px">
        <q-tooltip>{{ transferFailureText(activeTransfer) }}</q-tooltip>
      </q-icon>
      <q-icon v-else-if="activeTransfer.status === 'done'" name="check_circle_outline" color="positive" size="18px" />
    </div>

    <div v-if="voicePreparing || voiceRecording" class="voice-record-overlay" :class="{ cancelling: voiceCancelling }">
      <div class="voice-record-card">
        <q-icon :name="voiceCancelling ? 'delete_outline' : 'mic'" size="34px" />
        <div class="voice-record-time">{{ voicePreparing ? t("chat.micPreparing") : formatVoiceDuration(voiceDurationMs) }}</div>
        <div v-if="!voicePreparing" class="voice-levels" aria-hidden="true">
          <span
            v-for="index in 15"
            :key="index"
            :style="{ height: voiceBarHeight(index) + 'px' }"
          />
        </div>
        <div class="voice-record-hint">{{ voiceCancelling ? t("chat.releaseCancel") : t("chat.releaseSend") }}</div>
      </div>
    </div>

    <!-- Burn-after-read status: only takes up space when enabled -->
    <div v-if="burnMode" class="burn-mode-status">
      <q-icon name="local_fire_department" size="17px" />
      <div class="burn-mode-copy">
        <span>{{ t("chat.burnEnabled") }}</span>
        <small>{{ t("chat.burnExternalCopyWarning") }}</small>
      </div>
      <q-btn flat round dense icon="close" size="sm" :aria-label="t('chat.closeBurn')" @click="burnMode = false" />
    </div>

    <div v-if="replyTarget" class="reply-composer-bar">
      <q-icon name="reply" size="19px" color="primary" />
      <div class="reply-composer-content">
        <div class="reply-composer-title">{{ t('chat.replyingTo', { name: replySenderName(replyTarget) }) }}</div>
        <div class="reply-composer-preview">{{ replyPreviewText(replyTarget) }}</div>
      </div>
      <q-btn
        flat
        round
        dense
        icon="close"
        size="sm"
        :aria-label="t('chat.cancelReply')"
        @click="cancelReply"
      />
    </div>

    <div v-if="selectedImages.length || imageBatch.sending || imageProcessing.active" class="image-selection-tray">
      <div class="image-selection-header">
        <div class="image-selection-title">
          <q-icon name="photo_library" color="primary" size="19px" />
          <span>{{ imageSelectionSummary }}</span>
        </div>
        <q-btn
          v-if="!imageBatch.sending && !imageProcessing.active"
          flat
          dense
          no-caps
          color="grey-7"
          :label="t('chat.clearImages')"
          @click="clearSelectedImages"
        />
      </div>

      <div v-if="selectedImages.length && !imageBatch.sending" class="image-send-options">
        <div class="image-send-mode" role="group" :aria-label="t('chat.imageSendQuality')">
          <button
            type="button"
            :class="{ active: imageSendMode === 'high_quality' }"
            :disabled="imageProcessing.active"
            @click="setImageSendMode('high_quality')"
          >{{ t('chat.highQuality') }}</button>
          <button
            type="button"
            :class="{ active: imageSendMode === 'original' }"
            :disabled="imageProcessing.active"
            @click="setImageSendMode('original')"
          >{{ t('chat.originalImage') }}</button>
        </div>
        <span v-if="imageSendMode === 'original' && originalOversizeCount" class="image-original-warning">
          {{ t('chat.originalImageTooLarge', { count: originalOversizeCount, maxSize: formatFileSize(MAX_IMAGE_FILE_BYTES) }) }}
        </span>
      </div>

      <div v-if="selectedImages.length" class="image-selection-list">
        <div v-for="item in selectedImages" :key="item.id" class="image-selection-item">
          <img :src="item.previewUrl" :alt="selectedImageFile(item).name" />
          <button
            v-if="!imageBatch.sending && !imageProcessing.active"
            type="button"
            class="image-selection-remove"
            :aria-label="t('chat.removeImage', { name: selectedImageFile(item).name })"
            @click="removeSelectedImage(item.id)"
          >
            <q-icon name="close" size="16px" />
          </button>
          <span class="image-selection-name">{{ selectedImageFile(item).name }}</span>
          <span class="image-selection-size">{{ formatFileSize(selectedImageFile(item).size) }}</span>
        </div>
      </div>

      <div v-if="imageProcessing.active" class="image-batch-progress">
        <div class="row items-center no-wrap q-gutter-xs">
          <span class="col ellipsis">{{ t('chat.processingImages', { current: imageProcessing.current, total: imageProcessing.total }) }}</span>
        </div>
        <q-linear-progress indeterminate rounded color="primary" />
      </div>
      <div v-else-if="imageBatch.sending" class="image-batch-progress">
        <div class="row items-center no-wrap q-gutter-xs">
          <span class="col ellipsis">{{ t('chat.sendingImages', { current: imageBatch.current, total: imageBatch.total }) }}</span>
          <strong>{{ imageBatchProgress }}%</strong>
        </div>
        <q-linear-progress :value="imageBatchProgress / 100" rounded color="primary" />
      </div>
      <div v-else class="image-selection-footer">
        <span>{{ t('chat.imageSelectionHint') }}</span>
        <q-btn
          unelevated
          no-caps
          rounded
          color="primary"
          icon="send"
          :label="t('chat.sendImages', { count: selectedImages.length })"
          :disable="!selectedImages.length || isTransferring || imageSendBlocked"
          @click="sendSelectedImages"
        />
      </div>
    </div>

    <!-- Compact dynamic input bar -->
    <div class="chat-composer bg-white">
      <!-- Hidden image/file pickers -->
      <input
        ref="imageInputEl"
        type="file"
        multiple
        style="display: none"
        accept=".jpg,.jpeg,.png,.gif,.webp,.bmp,image/jpeg,image/png,image/gif,image/webp,image/bmp"
        @change="onImagesSelected"
      />
      <input
        ref="fileInputEl"
        type="file"
        style="display: none"
        :accept="allowedFileTypes"
        @change="onFileSelected"
      />

      <!-- Switch between text and hold-to-talk modes -->
      <q-btn
        round
        flat
        dense
        :icon="voiceInputMode ? 'keyboard' : 'mic_none'"
        color="grey-7"
        :disable="voicePreparing || voiceRecording"
        :aria-label="voiceInputMode ? t('chat.textMode') : t('chat.voiceMode')"
        @click="toggleVoiceInputMode"
      >
        <q-tooltip>{{ voiceInputMode ? t("chat.textMode") : t("chat.voiceMode") }}</q-tooltip>
      </q-btn>

      <button
        v-if="voiceInputMode"
        type="button"
        class="voice-hold-input"
        :class="{ recording: voicePreparing || voiceRecording }"
        :disabled="sending || voiceSending || isTransferring || callStore.state !== 'idle'"
        @pointerdown.prevent="beginVoiceGesture"
        @contextmenu.prevent
      >
        {{ voicePreparing ? t("chat.micPreparing") : voiceRecording ? t("chat.releaseSend") : t("chat.holdToTalk") }}
      </button>

      <q-input
        v-else
        ref="inputEl"
        v-model="inputText"
        outlined
        dense
        rounded
        :placeholder="t('chat.inputPlaceholder')"
        class="composer-input"
        @keyup.enter="sendMsg"
        @keyup.esc="cancelReply"
        @paste="onComposerPaste"
        @focus="morePanelOpen = false"
        :disable="sending || voiceSending || voiceRecording"
      />

      <q-btn v-if="!voiceInputMode" round flat dense icon="sentiment_satisfied_alt" color="grey-7" :aria-label="t('chat.emoji')">
        <q-menu anchor="top right" self="bottom right" :offset="[0, 8]" max-height="260px">
          <div style="width: 288px">
            <q-tabs v-model="emojiTab" dense align="justify" class="bg-grey-2 text-grey-8" indicator-color="primary" style="font-size:18px">
              <q-tab v-for="cat in emojiData" :key="cat.name" :name="cat.name" :label="cat.icon" />
            </q-tabs>
            <div class="q-pa-xs overflow-auto" style="max-height: 200px">
              <span
                v-for="(e, emojiIndex) in currentEmojis"
                :key="emojiTab + '-' + emojiIndex"
                class="emoji-item"
                @click="insertEmoji(e)"
              >{{ e }}</span>
            </div>
          </div>
        </q-menu>
      </q-btn>

      <q-btn
        v-if="hasInputText && !voiceInputMode"
        round
        unelevated
        dense
        :color="burnMode ? 'orange' : 'primary'"
        icon="send"
        :loading="sending || voiceSending"
        :aria-label="t('chat.send')"
        @click="sendMsg"
      />
      <q-btn
        v-else
        round
        flat
        dense
        :icon="morePanelOpen ? 'close' : 'add'"
        color="grey-7"
        :disable="sending || voiceSending || voicePreparing || voiceRecording || isTransferring || imageProcessing.active"
        :aria-label="t('chat.more')"
        @click="toggleMorePanel"
      />
    </div>

    <q-slide-transition>
      <div v-show="morePanelOpen" class="composer-more-panel">
        <button
          type="button"
          class="composer-more-action"
          :disabled="sending || voiceSending || voiceRecording || imageBatch.sending || imageProcessing.active"
          @click="openImagePicker"
        >
          <span class="composer-more-icon"><q-icon name="photo_library" size="26px" /></span>
          <span>{{ t("chat.images") }}</span>
          <small>{{ t("chat.imagePickerHint") }}</small>
        </button>
        <button
          type="button"
          class="composer-more-action"
          :disabled="sending || voiceSending || voiceRecording || isTransferring || imageProcessing.active"
          @click="openFilePicker"
        >
          <span class="composer-more-icon"><q-icon name="attach_file" size="26px" /></span>
          <span>{{ t("chat.file") }}</span>
          <small>{{ t("chat.maxFileSize") }}</small>
        </button>
        <button
          type="button"
          class="composer-more-action"
          :class="{ active: burnMode }"
          @click="toggleBurnMode"
        >
          <span class="composer-more-icon"><q-icon name="local_fire_department" size="26px" /></span>
          <span>{{ burnMode ? t("chat.closeBurn") : t("chat.burn") }}</span>
          <small>{{ t("chat.burnDeleteHint") }}</small>
        </button>
      </div>
    </q-slide-transition>

    <image-gallery-dialog
      v-model="imagePreview.show"
      :images="galleryImages"
      :start-id="imagePreview.startId"
      @download="downloadGalleryImage"
    />
  </q-page>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import { copyToClipboard, useQuasar } from 'quasar'
import { useChatStore } from 'src/stores/chat'
import { useIdentityStore } from 'src/stores/identity'
import { useCallStore } from 'src/stores/call'
import { friendApi } from 'src/services/api'
import { on, off, getServerNow, getCalibratedServerNow } from 'src/services/websocket'
import {
  MAX_VOICE_DURATION_MS,
  MIN_VOICE_DURATION_MS,
  chooseVoiceFormat,
  createVoiceFilename,
  formatVoiceDuration,
} from 'src/services/voice-recorder.mjs'
import DeterministicAvatar from 'src/components/DeterministicAvatar.vue'
import ImageGalleryDialog from 'src/components/ImageGalleryDialog.vue'
import MessageActionMenu from 'src/components/MessageActionMenu.vue'
import { useI18n } from 'src/i18n'
import {
  acceptBurnWarning,
  hasAcceptedBurnWarning,
  loadBurnMode,
  saveBurnMode,
} from 'src/services/chat-preferences.mjs'
import { normalizeReplyReference } from 'src/services/chat-message-content.mjs'
import {
  MAX_IMAGE_BATCH_BYTES,
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_SELECTION,
  MAX_IMAGE_SOURCE_BYTES,
  extractClipboardImageFiles,
  imageSelectionKey,
  inferImageMimeType,
  mergeImageSelection,
} from 'src/services/image-selection.mjs'
import { compressImageForSending } from 'src/services/image-compression.mjs'
import { createChatWatermark } from 'src/services/chat-watermark.mjs'
import { setSecureScreen } from 'src/services/chat-service-plugin'
import {
  saveChunkReaderWithBrowserPicker,
  saveChunkReaderWithCapacitor,
  saveChunkReaderWithTauri,
  saveObjectUrlWithTauri,
  triggerBrowserDownload,
} from 'src/services/file-download.mjs'
import { classifyAttachmentError } from 'src/services/attachment-errors.mjs'
import { isCapacitor, isTauri } from 'src/services/platform.js'

// ── File utility functions ─────────────────────────────────────────────

const COMPRESSED_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz'])

function getFileIcon(filetype, filename) {
  const ext = filename?.split('.').pop()?.toLowerCase() ?? ''
  if (COMPRESSED_EXTENSIONS.has(ext)) return '🗜️'
  if (!filetype) return '📎'
  if (filetype.startsWith('image/')) return '🖼️'
  if (filetype.startsWith('video/')) return '🎬'
  if (filetype.includes('pdf')) return '📄'
  if (filetype.includes('word') || filetype.includes('document')) return '📝'
  if (filetype.includes('excel') || filetype.includes('sheet')) return '📊'
  if (filetype.includes('powerpoint') || filetype.includes('presentation')) return '📋'
  if (filetype.includes('zip') || filetype.includes('rar') || filetype.includes('7z') || filetype.includes('tar') || filetype.includes('gzip')) return '🗜️'
  if (filetype.includes('android') || filetype.includes('apk')) return '🤖'
  return '📎'
}

function formatFileSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function isMsgImage(msg) { return msg.filetype?.startsWith('image/') }
function isMsgVideo(msg) { return msg.filetype?.startsWith('video/') }
function isMsgVoice(msg) { return msg.kind === 'voice' || msg.filetype?.startsWith('audio/') }

const $q = useQuasar()
const route = useRoute()
const chatStore = useChatStore()
const identityStore = useIdentityStore()
const callStore = useCallStore()
const { locale, t } = useI18n()

// chatId format verification: NNNN-AAAA (4 digits - 4 uppercase letters)
const CHAT_ID_PATTERN = /^\d{4}-[A-Z]{4}$/
const friendChatId = route.params.chatId
if (!CHAT_ID_PATTERN.test(friendChatId)) {
  $q.notify({ type: 'negative', message: t('chat.invalidId') })
  throw new Error('Invalid chatId format')
}
const virtualScrollEl = ref(null)
const pageEl = ref(null)
const inputEl = ref(null)
const imageInputEl = ref(null)
const fileInputEl = ref(null)
const inputText = ref('')
const sending = ref(false)
const retryingMessageId = ref(null)
const burnMode = ref(loadBurnMode(identityStore.chatId, friendChatId))
const replyTarget = ref(null)
const highlightedMessageId = ref(null)
const voiceInputMode = ref(false)
const morePanelOpen = ref(false)
const hasInputText = computed(() => inputText.value.trim().length > 0)
// The message area is displayed only after the initial scroll to the bottom is completed to avoid users seeing jitter when jumping from the middle to the bottom.
const scrolled = ref(false)
// The server calibration time is refreshed every minute, and the driver displays a countdown that burns after reading.
const now = ref(getServerNow())
const watermarkNow = ref(getCalibratedServerNow())
const watermarkText = computed(() => createChatWatermark(identityStore.chatId, watermarkNow.value))
let nowTimer = null
let nudgeTimer = null
let heightResizeObserver = null
let rafNudgeId = null
let highlightTimer = null
const pendingImageBottomIds = new Set()
const measuredImageIds = new Set()
const imagePreview = ref({ show: false, startId: '' })
const selectedImages = ref([])
const imageSendMode = ref('high_quality')
const imageProcessing = ref({ active: false, current: 0, total: 0 })
const imageBatch = ref({
  sending: false,
  id: '',
  current: 0,
  total: 0,
  completedBytes: 0,
  totalBytes: 0,
})
function selectedImageFile(item) {
  return imageSendMode.value === 'original' ? item.originalFile : item.preparedFile
}
const selectedImageBytes = computed(() => selectedImages.value.reduce((sum, item) => sum + selectedImageFile(item).size, 0))
const selectedImageOriginalBytes = computed(() => selectedImages.value.reduce((sum, item) => sum + item.originalFile.size, 0))
const hasCompressedImages = computed(() => selectedImages.value.some(item => item.compressed))
const originalOversizeCount = computed(() => selectedImages.value.filter(item => item.originalFile.size > MAX_IMAGE_FILE_BYTES).length)
const imageSendBlocked = computed(() =>
  imageProcessing.value.active ||
  (imageSendMode.value === 'original' && originalOversizeCount.value > 0) ||
  selectedImageBytes.value > MAX_IMAGE_BATCH_BYTES
)
const imageSelectionSummary = computed(() => {
  const params = {
    count: selectedImages.value.length,
    original: formatFileSize(selectedImageOriginalBytes.value),
    size: formatFileSize(selectedImageBytes.value),
  }
  return imageSendMode.value === 'high_quality' && hasCompressedImages.value
    ? t('chat.selectedImagesCompressed', params)
    : t('chat.selectedImages', params)
})
const voicePreparing = ref(false)
const voiceRecording = ref(false)
const voiceCancelling = ref(false)
const voiceSending = ref(false)
const voiceDurationMs = ref(0)
const voiceLevel = ref(0)
const playingVoiceId = ref(null)
const fileDownloads = ref({})
const downloadResetTimers = new Set()

let voiceStream = null
let mediaRecorder = null
let voiceChunks = []
let voiceFormat = null
let voiceStartedAt = 0
let voiceStartY = 0
let voicePointerHeld = false
let voiceStopping = false
let voiceElapsedTimer = null
let voiceMaxTimer = null
let voiceAudioContext = null
let voiceAnalyser = null
let voiceLevelFrame = null
let voicePlayer = null
let chatPageUnmounted = false

// Allowed file types (for input accept attribute)
const allowedFileTypes = [
  '.jpg,.jpeg,.png,.gif,.webp,.bmp,.svg',
  '.mp4,.webm,.mov',
  '.doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf',
  '.zip,.rar,.7z,.tar,.gz,.apk'
].join(',')

// ── File saving ─────────────────────────────────────────────────

function fileDownloadState(msg) {
  return fileDownloads.value[msg.id] || null
}

function setFileDownloadState(msgId, state) {
  fileDownloads.value = { ...fileDownloads.value, [msgId]: state }
}

function clearFileDownloadState(msgId) {
  const next = { ...fileDownloads.value }
  delete next[msgId]
  fileDownloads.value = next
}

function isFileDownloading(msg) {
  return fileDownloadState(msg)?.status === 'downloading'
}

function fileDownloadProgress(msg) {
  return fileDownloadState(msg)?.progress || 0
}

function fileDownloadStatusText(msg) {
  const state = fileDownloadState(msg)
  if (state?.status === 'done') return t('chat.fileSaved')
  return t('chat.savingFileProgress', { progress: state?.progress || 0 })
}

function fileDownloadIcon(msg) {
  const state = fileDownloadState(msg)
  if (state?.status === 'downloading') return 'hourglass_top'
  if (state?.status === 'done') return 'check_circle'
  return 'download'
}

function fileDownloadTooltip(msg) {
  const state = fileDownloadState(msg)
  if (state?.status === 'done') return t('chat.fileSavedAt', { path: state.path })
  if (state?.status === 'downloading') return t('chat.savingFileProgress', { progress: state.progress || 0 })
  return t('chat.downloadFile')
}

function attachmentFailureText(error, phase = 'transfer') {
  if (error?.code === 'attachment_file_too_large') {
    return t('chat.attachmentFileTooLarge', {
      size: formatFileSize(error.fileSize || 0),
      max: formatFileSize(error.maxBytes || 500 * 1024 * 1024),
    })
  }
  if (error?.code === 'attachment_file_empty') return t('chat.attachmentFileEmpty')
  if (error?.code === 'attachment_filename_invalid') return t('chat.attachmentFilenameInvalid')
  if (error?.code === 'attachment_filetype_invalid') return t('chat.attachmentFiletypeInvalid')
  if (error?.code === 'attachment_filetype_unsupported') return t('chat.attachmentFiletypeUnsupported')
  const reason = classifyAttachmentError(error, phase)
  if (reason === 'local_storage') return t('chat.localAttachmentStorageFull')
  if (reason === 'server_quota') return t('chat.serverAttachmentQuotaFull')
  if (reason === 'destination_storage') return t('chat.destinationStorageFull')
  if (reason === 'network') return t('chat.networkAttachmentError')
  if (reason === 'expired') return t('chat.expiredAttachmentError')
  if (reason === 'corrupted') return t('chat.corruptedAttachmentError')
  return error?.message || t('chat.unknownError')
}

function transferFailureText(transfer) {
  return attachmentFailureText({ code: transfer?.errorCode, message: transfer?.errorReason })
}

async function downloadFile(msg) {
  if (!msg || (!msg.objectUrl && !msg.localFileAvailable) || isFileDownloading(msg)) return

  const existing = fileDownloadState(msg)
  if (existing?.status === 'done') {
    $q.notify({
      type: 'positive',
      message: t('chat.fileAlreadySaved', { name: msg.filename }),
      caption: existing.path,
    })
    return
  }

  if (!await confirmBurnAttachmentSave(msg)) return

  setFileDownloadState(msg.id, { status: 'downloading', progress: 0 })
  try {
    const onProgress = progress => setFileDownloadState(msg.id, { status: 'downloading', progress })
    const getDescriptor = () => chatStore.getStoredFileDescriptor(msg)
    const useChunkedSave = !!msg.offlineAttachment && msg.filesize > 20 * 1024 * 1024
    let savedResult = null

    if (isTauri()) {
      if (useChunkedSave) {
        savedResult = await saveChunkReaderWithTauri({
          filename: msg.filename,
          totalBytes: msg.filesize,
          dialogTitle: t('chat.saveFileTitle'),
          getDescriptor,
          onProgress,
        })
      } else {
        const objectUrl = msg.objectUrl || await chatStore.ensureFileObjectUrl(msg)
        if (!objectUrl) throw new Error(t('chat.expired'))
        savedResult = await saveObjectUrlWithTauri({
          objectUrl,
          filename: msg.filename,
          totalBytes: msg.filesize,
          dialogTitle: t('chat.saveFileTitle'),
          onProgress,
        })
      }
    } else if (isCapacitor() && msg.offlineAttachment) {
      savedResult = await saveChunkReaderWithCapacitor({
        filename: msg.filename,
        mimeType: msg.filetype,
        totalBytes: msg.filesize,
        getDescriptor,
        onProgress,
      })
    } else if (useChunkedSave) {
      const result = await saveChunkReaderWithBrowserPicker({
        filename: msg.filename,
        totalBytes: msg.filesize,
        getDescriptor,
        onProgress,
      })
      if (!result.unsupported) savedResult = result
    }

    if (savedResult) {
      if (savedResult.canceled) {
        clearFileDownloadState(msg.id)
        return
      }
      setFileDownloadState(msg.id, { status: 'done', progress: 100, path: savedResult.path })
      $q.notify({
        type: 'positive',
        icon: 'download_done',
        message: t('chat.fileDownloadComplete', { name: msg.filename }),
        caption: t('chat.fileSavedAt', { path: savedResult.path }),
        timeout: 5000,
      })
      return
    }

    const objectUrl = msg.objectUrl || await chatStore.ensureFileObjectUrl(msg)
    if (!objectUrl) throw new Error(t('chat.expired'))
    triggerBrowserDownload(objectUrl, msg.filename)
    $q.notify({
      type: 'info',
      icon: 'download',
      message: t('chat.fileDownloadStarted', { name: msg.filename }),
      timeout: 3000,
    })
    const timer = setTimeout(() => {
      clearFileDownloadState(msg.id)
      downloadResetTimers.delete(timer)
    }, 2500)
    downloadResetTimers.add(timer)
  } catch (error) {
    clearFileDownloadState(msg.id)
    $q.notify({
      type: 'negative',
      message: t('chat.fileDownloadFailed', { error: attachmentFailureText(error, 'save') }),
    })
  }
}

// ── Voice recording and playback ───────────────────────────────────

function toggleVoiceInputMode() {
  const keepBottom = isNearBottom()
  voiceInputMode.value = !voiceInputMode.value
  morePanelOpen.value = false
  if (voiceInputMode.value) inputEl.value?.blur?.()
  nextTick(() => {
    if (!voiceInputMode.value) inputEl.value?.focus?.()
    if (keepBottom) scrollToBottomReliable()
  })
}

function toggleMorePanel() {
  const keepBottom = isNearBottom()
  const opening = !morePanelOpen.value
  morePanelOpen.value = opening
  if (opening) inputEl.value?.blur?.()
  if (keepBottom) nextTick(() => scrollToBottomReliable())
}

function openFilePicker() {
  morePanelOpen.value = false
  fileInputEl.value?.click()
}

function openImagePicker() {
  if (imageProcessing.value.active || imageBatch.value.sending) return
  morePanelOpen.value = false
  imageInputEl.value?.click()
}

function showConfirmDialog(options) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    $q.dialog({ ...options, persistent: true })
      .onOk(() => finish(true))
      .onCancel(() => finish(false))
      .onDismiss(() => finish(false))
  })
}

async function ensureBurnWarningAccepted() {
  if (hasAcceptedBurnWarning(identityStore.chatId)) return true
  const accepted = await showConfirmDialog({
    title: t('chat.burnRiskTitle'),
    message: t('chat.burnRiskMessage'),
    cancel: { label: t('common.cancel'), flat: true },
    ok: { label: t('chat.burnRiskConfirm'), color: 'orange' },
  })
  if (accepted) acceptBurnWarning(identityStore.chatId)
  return accepted
}

async function toggleBurnMode() {
  if (burnMode.value) {
    burnMode.value = false
  } else if (await ensureBurnWarningAccepted()) {
    burnMode.value = true
  }
  morePanelOpen.value = false
}

function confirmBurnAttachmentSave(msg) {
  if (!msg?.burnAfterRead) return Promise.resolve(true)
  return showConfirmDialog({
    title: t('chat.burnSaveTitle'),
    message: t('chat.burnSaveMessage'),
    cancel: { label: t('common.cancel'), flat: true },
    ok: { label: t('chat.burnSaveConfirm'), color: 'orange' },
  })
}

watch(burnMode, enabled => {
  saveBurnMode(identityStore.chatId, friendChatId, enabled)
})

function voiceBarHeight(index) {
  const shape = 0.45 + Math.abs(Math.sin(index * 1.37)) * 0.55
  return 4 + Math.round(voiceLevel.value * shape * 30)
}

function addVoicePointerListeners() {
  window.addEventListener('pointermove', updateVoiceGesture, { passive: true })
  window.addEventListener('pointerup', endVoiceGesture, { once: true })
  window.addEventListener('pointercancel', cancelVoiceGesture, { once: true })
}

function removeVoicePointerListeners() {
  window.removeEventListener('pointermove', updateVoiceGesture)
  window.removeEventListener('pointerup', endVoiceGesture)
  window.removeEventListener('pointercancel', cancelVoiceGesture)
}

async function beginVoiceGesture(event) {
  if (voicePreparing.value || voiceRecording.value || voiceStopping) return
  if (!friendPubKey.value) {
    $q.notify({ type: 'warning', message: t('chat.noPublicKey') })
    return
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    $q.notify({ type: 'warning', message: t('chat.micUnsupported') })
    return
  }

  voicePointerHeld = true
  voiceStartY = event.clientY
  voiceCancelling.value = false
  voicePreparing.value = true
  try { event.currentTarget?.setPointerCapture?.(event.pointerId) } catch { /* unsupported capture */ }
  addVoicePointerListeners()

  try {
    voiceFormat = chooseVoiceFormat()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    })

    if (!voicePointerHeld) {
      stream.getTracks().forEach(track => track.stop())
      voicePreparing.value = false
      return
    }

    voiceStream = stream
    voiceChunks = []
    mediaRecorder = new MediaRecorder(stream, { mimeType: voiceFormat.mimeType })
    mediaRecorder.addEventListener('dataavailable', event => {
      if (event.data?.size) voiceChunks.push(event.data)
    })
    mediaRecorder.start(200)

    voicePreparing.value = false
    voiceRecording.value = true
    voiceStartedAt = Date.now()
    voiceDurationMs.value = 0
    startVoiceLevelMeter(stream)
    voiceElapsedTimer = setInterval(() => {
      voiceDurationMs.value = Date.now() - voiceStartedAt
    }, 100)
    voiceMaxTimer = setTimeout(() => {
      voicePointerHeld = false
      removeVoicePointerListeners()
      finishVoiceRecording(false)
    }, MAX_VOICE_DURATION_MS)
  } catch (error) {
    voicePointerHeld = false
    voicePreparing.value = false
    removeVoicePointerListeners()
    stopVoiceCaptureResources()
    const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError'
    $q.notify({
      type: 'warning',
      message: denied ? t('chat.micDenied') : t('chat.recordStartFailed', { error: error?.message || t('chat.unknownError') })
    })
  }
}

function updateVoiceGesture(event) {
  if (!voicePointerHeld) return
  voiceCancelling.value = voiceStartY - event.clientY > 80
}

function endVoiceGesture() {
  const shouldCancel = voiceCancelling.value
  voicePointerHeld = false
  removeVoicePointerListeners()
  if (voicePreparing.value) return
  finishVoiceRecording(shouldCancel)
}

function cancelVoiceGesture() {
  voicePointerHeld = false
  removeVoicePointerListeners()
  if (voicePreparing.value) return
  finishVoiceRecording(true)
}

function startVoiceLevelMeter(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) return
  try {
    voiceAudioContext = new AudioContextClass()
    voiceAnalyser = voiceAudioContext.createAnalyser()
    voiceAnalyser.fftSize = 256
    voiceAudioContext.createMediaStreamSource(stream).connect(voiceAnalyser)
    const samples = new Uint8Array(voiceAnalyser.frequencyBinCount)
    const update = () => {
      if (!voiceAnalyser || !voiceRecording.value) return
      voiceAnalyser.getByteFrequencyData(samples)
      const average = samples.reduce((sum, value) => sum + value, 0) / samples.length
      voiceLevel.value = Math.min(1, average / 90)
      voiceLevelFrame = requestAnimationFrame(update)
    }
    update()
  } catch {
    voiceLevel.value = 0.2
  }
}

function clearVoiceTimers() {
  if (voiceElapsedTimer) { clearInterval(voiceElapsedTimer); voiceElapsedTimer = null }
  if (voiceMaxTimer) { clearTimeout(voiceMaxTimer); voiceMaxTimer = null }
  if (voiceLevelFrame) { cancelAnimationFrame(voiceLevelFrame); voiceLevelFrame = null }
}

function stopVoiceCaptureResources() {
  clearVoiceTimers()
  voiceStream?.getTracks().forEach(track => track.stop())
  voiceStream = null
  voiceAnalyser = null
  if (voiceAudioContext) voiceAudioContext.close().catch(() => {})
  voiceAudioContext = null
  voiceLevel.value = 0
}

async function finishVoiceRecording(cancelled) {
  if (voiceStopping || !mediaRecorder) return
  voiceStopping = true
  const recorder = mediaRecorder
  const durationMs = Math.min(MAX_VOICE_DURATION_MS, Math.max(0, Date.now() - voiceStartedAt))
  // Releasing the button ends the recording interaction immediately.  File
  // finalisation and encrypted upload may take longer, but must not leave the
  // recording overlay or microphone UI visible during that work.
  voiceRecording.value = false
  voicePreparing.value = false
  voiceCancelling.value = false
  clearVoiceTimers()

  try {
    const blob = await new Promise(resolve => {
      recorder.addEventListener('stop', () => {
        resolve(new Blob(voiceChunks, { type: recorder.mimeType || voiceFormat.mimeType }))
      }, { once: true })
      recorder.stop()
      stopVoiceCaptureResources()
    })

    if (cancelled) {
      $q.notify({ type: 'info', message: t('chat.recordingCanceled') })
      return
    }
    if (durationMs < MIN_VOICE_DURATION_MS || blob.size === 0) {
      $q.notify({ type: 'warning', message: t('chat.recordingTooShort') })
      return
    }

    const file = new File(
      [blob],
      createVoiceFilename(voiceFormat.extension),
      { type: recorder.mimeType || voiceFormat.mimeType, lastModified: Date.now() }
    )
    voiceSending.value = true
    await chatStore.sendFile(
      friendChatId,
      friendPubKey.value,
      file,
      burnMode.value,
      { kind: 'voice', durationMs: Math.round(durationMs) }
    )
  } catch (error) {
    $q.notify({ type: 'negative', message: t('chat.voiceSendFailed', { error: error?.message || t('chat.unknownError') }) })
  } finally {
    mediaRecorder = null
    voiceChunks = []
    voiceSending.value = false
    voiceDurationMs.value = 0
    stopVoiceCaptureResources()
    voiceStopping = false
  }
}

function toggleVoicePlayback(msg) {
  if (!msg.objectUrl) return
  if (playingVoiceId.value === msg.id && voicePlayer) {
    voicePlayer.pause()
    playingVoiceId.value = null
    return
  }
  if (voicePlayer) voicePlayer.pause()
  voicePlayer = new Audio(msg.objectUrl)
  playingVoiceId.value = msg.id
  voicePlayer.addEventListener('ended', () => { playingVoiceId.value = null }, { once: true })
  voicePlayer.addEventListener('error', () => {
    playingVoiceId.value = null
    $q.notify({ type: 'warning', message: t('chat.voiceUnavailable') })
  }, { once: true })
  voicePlayer.play().catch(() => {
    playingVoiceId.value = null
    $q.notify({ type: 'warning', message: t('chat.voicePlaybackFailed') })
  })
}

// Transmission currently in progress (send or receive)
const activeTransfer = computed(() => {
  const transfers = Object.values(chatStore.fileTransfers)
  return transfers.find(t =>
    (t.toChatId === friendChatId || t.fromChatId === friendChatId) &&
    (t.status === 'pending' || t.status === 'transferring' || t.status === 'processing' || t.status === 'paused')
  ) || transfers.find(t =>
    (t.toChatId === friendChatId || t.fromChatId === friendChatId) &&
    t.status === 'error' && (t.transport === 'offline' || Date.now() - (t.errorAt || 0) < 5000)
  ) || null
})

const isTransferring = computed(() =>
  Object.values(chatStore.fileTransfers).some(t =>
    (t.toChatId === friendChatId || t.fromChatId === friendChatId) &&
    (t.status === 'pending' || t.status === 'transferring' || t.status === 'processing')
  )
)

const imageBatchProgress = computed(() => {
  const batch = imageBatch.value
  if (!batch.sending || !batch.totalBytes) return 0
  const currentTransfer = Object.values(chatStore.fileTransfers).find(transfer =>
    transfer.batchId === batch.id &&
    transfer.batchIndex === batch.current - 1 &&
    transfer.status !== 'done'
  )
  const currentBytes = currentTransfer
    ? currentTransfer.filesize * Math.max(0, Math.min(100, currentTransfer.progress || 0)) / 100
    : 0
  return Math.min(100, Math.round((batch.completedBytes + currentBytes) / batch.totalBytes * 100))
})

function attachmentStatusText(msg) {
  const saving = fileDownloadState(msg)
  if (saving?.status === 'downloading') return t('chat.attachmentSaving')
  if (saving?.status === 'done') return t('chat.fileSaved')
  const transfer = msg.attachmentId ? chatStore.fileTransfers[msg.attachmentId] : null
  let status = msg.attachmentStatus
  if (transfer) {
    if (transfer.status === 'paused') status = 'paused'
    else if (transfer.status === 'error') status = 'failed'
    else if (transfer.status === 'processing') status = transfer.direction === 'receive' ? 'saving' : 'waiting'
    else if (transfer.status === 'pending') status = 'preparing'
    else if (transfer.status === 'transferring') status = transfer.direction === 'receive' ? 'receiving' : 'uploading'
  }
  return {
    preparing: t('chat.attachmentPreparing'),
    uploading: t('chat.attachmentUploading'),
    waiting: t('chat.attachmentWaiting'),
    received: t('chat.attachmentReceived'),
    saving: t('chat.attachmentSaving'),
    expired: t('chat.attachmentExpired'),
    failed: t('chat.attachmentFailed'),
    paused: t('chat.transferPaused'),
    receiving: t('chat.attachmentReceiving'),
  }[status] || (msg.localFileAvailable ? t('chat.attachmentReceived') : t('chat.attachmentExpired'))
}

function activeTransferStatusText(transfer) {
  if (transfer.status === 'error') return t('chat.attachmentFailed')
  if (transfer.status === 'paused') return t('chat.transferPaused')
  if (transfer.status === 'pending') return t('chat.attachmentPreparing')
  if (transfer.status === 'processing') return transfer.direction === 'receive' ? t('chat.attachmentSaving') : t('chat.attachmentWaiting')
  if (transfer.status === 'transferring') {
    const label = transfer.direction === 'receive' ? t('chat.attachmentReceiving') : t('chat.attachmentUploading')
    return `${label} ${transfer.progress}%`
  }
  return `${transfer.progress}%`
}

// ── Expression Panel ────────────────────────────────────────────────
const emojiTab = ref('face')

const emojiData = [
  {
    name: 'face', icon: '😊',
    emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖']
  },
  {
    name: 'gesture', icon: '👋',
    emojis: ['👋','🤚','🖐️','✋','🖖','🤙','👌','🤌','🤏','✌️','🤞','🤟','🤘','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🙏','💪','🤳','🫶','🫱','🫲','🧑','👦','👧','👨','👩','🧒','👶','👴','👵','🧓','👮','👷','💂','🕵️','👩‍⚕️','👨‍⚕️','👩‍🍳','👨‍🍳','👩‍🎓','👨‍🎓','👩‍🏫','👨‍🏫','💆','💇','🚶','🧍','🧎','🏃','💃','🕺','🧖','🛀','🧗','🤸','⛹️','🏋️','🤼','🤺','🤾','🏇','⛷️','🏂','🏌️','🚵','🚴','🧘']
  },
  {
    name: 'heart', icon: '❤️',
    emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','✡️','🆘','❌','⭕','🛑','⛔','🚫','💯','✅','☑️','✔️','❎','🔝','🆙','🆒','🆕','🆓','🆗','🅰️','🅱️','🆎','🆑','🅾️','🆘','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🔲','🔳','▪️','▫️','◾','◽','◼️','◻️','🟥','🟧','🟨','🟩','🟦','🟪','⬛','⬜','🟫']
  },
  {
    name: 'animal', icon: '🐱',
    emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🐈','🐓','🦃','🦚','🦜','🦢','🕊️','🐇','🦝','🦨','🦡','🦦','🦥','🐿️','🦔','🐉','🐲']
  },
  {
    name: 'food', icon: '🍎',
    emojis: ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🍞','🥖','🧀','🥚','🍳','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🥪','🥙','🌮','🌯','🥗','🥘','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🍤','🍙','🍚','🍘','🍥','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🧃','🥤','🧋','☕','🍵','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🍾','🥄','🍴','🍽️']
  },
  {
    name: 'activity', icon: '⚽',
    emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🏒','🥅','⛳','🎣','🤿','🎽','🎿','🛷','🥌','🎯','🎳','🎮','🕹️','🎰','🧩','♟️','🎭','🎨','🎬','🎤','🎧','🎼','🎵','🎶','🎷','🎸','🎹','🥁','🎺','🎻','🏆','🥇','🥈','🥉','🏅','🎖️','🎗️','🎫','🎟️','🎪','🤹','🎠','🎡','🎢','🎆','🎇','🧨','🎉','🎊','🎈','🎁','🎀','🎋','🎍','🎑','🎐','🧧','🎎','🧸','🪆','🪅','🏮']
  },
  {
    name: 'object', icon: '💡',
    emojis: ['📱','💻','⌨️','🖥️','🖨️','🖱️','💾','💿','📀','📸','📷','📹','🎥','📞','☎️','📺','📻','🧭','⏰','⌛','⏳','🔋','🔌','💡','🔦','🕯️','💵','💳','💎','💍','👑','🏺','🧸','🎁','🎀','🧲','🔧','🔨','⚙️','🔩','🪛','🔫','🧨','💣','🗡️','⚔️','🛡️','🚪','🪑','🛁','🚽','🧴','🧹','🧺','🧻','🪣','🧼','🪥','🛒','🚬','⚗️','🔭','🔬','🩺','💊','🩹','🩻','🩼','🩺','🧬','🦠','🌡️','🔑','🗝️','🔐','🔏','🔒','🔓','📦','📫','📬','📭','📮','🗳️','✏️','✒️','🖊️','📝','📄','📃','📋','📁','📂','🗂️','📅','📆','📇','📈','📉','📊','📌','📍','✂️','🗃️','🗄️','🗑️','🔎','🔍','🔏','🔐','🔒','🔓']
  }
]

const currentEmojis = computed(() => emojiData.find(c => c.name === emojiTab.value)?.emojis ?? [])

function insertEmoji(emoji) {
  const native = inputEl.value?.getNativeElement?.()
  // QInput.getNativeElement() returns the native input/textarea; it is compatible with older versions that may return containers.
  const input = native?.matches?.('input, textarea')
    ? native
    : native?.querySelector?.('input, textarea')
  if (input) {
    const start = input.selectionStart ?? inputText.value.length
    const end = input.selectionEnd ?? inputText.value.length
    inputText.value = inputText.value.slice(0, start) + emoji + inputText.value.slice(end)
    nextTick(() => {
      input.focus()
      // selectionStart/setSelectionRange uses UTF-16 code unit index, consistent with String.length.
      const pos = start + emoji.length
      input.setSelectionRange(pos, pos)
    })
  } else {
    inputText.value += emoji
  }
}

// Friend information (obtained from cache or API)
const friendNickname = ref('...')
const friendOnline = ref(false)

// Obtain friend's public key: only obtain it from trusted sources (local cache or API), prohibit injection from URL parameters
const friendPubKey = ref(identityStore.getFriendPubKey(friendChatId) || '')

const messages = computed(() => chatStore.getMessages(friendChatId))
const galleryImages = computed(() => messages.value
  .filter(message => isMsgImage(message) && message.objectUrl)
  .map(message => ({
    id: message.id,
    url: message.objectUrl,
    name: message.filename || t('chat.imageMessage'),
  })))

function openImagePreview(message) {
  if (!message?.id || !message.objectUrl) return
  imagePreview.value = { show: true, startId: message.id }
}

function downloadGalleryImage(image) {
  const message = messages.value.find(item => item.id === image?.id)
  if (message) downloadFile(message)
}

let stopStatus = null

function handleVoiceVisibilityChange() {
  if (!document.hidden) return
  voicePointerHeld = false
  removeVoicePointerListeners()
  if (voiceRecording.value) finishVoiceRecording(true)
}

onMounted(async () => {
  chatPageUnmounted = false
  // Android uses the native FLAG_SECURE only while the chat page is visible.
  // H5 and desktop builds use a no-op implementation and retain the traceable watermark.
  setSecureScreen(true)

  // Register status listeners first to avoid missing status change events during asynchronous waiting.
  stopStatus = onStatusUpdate((chatId, online) => {
    if (chatId === friendChatId) {
      friendOnline.value = online
    }
  })

  // Existing users may already have burn mode persisted from an older version.
  // Require the same one-time acknowledgement before they continue using it.
  if (burnMode.value && !hasAcceptedBurnWarning(identityStore.chatId)) {
    const accepted = await ensureBurnWarningAccepted()
    if (!accepted) burnMode.value = false
  }

  // Precisely set the q-page height: the first synchronization attempt, and then add it after nextTick + rAF,
  // Ensure that the header/footer size is accurate after Quasar completes the layout
  updatePageHeight()
  nextTick(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => updatePageHeight())
    })
  })
  // Monitor header/footer height changes (such as the appearance/disappearance of the disconnection prompt bar)
  const header = document.querySelector('.q-header')
  const footer = document.querySelector('.q-footer')
  if (header || footer) {
    heightResizeObserver = new ResizeObserver(() => updatePageHeight())
    if (header) heightResizeObserver.observe(header)
    if (footer) heightResizeObserver.observe(footer)
  }
  window.addEventListener('resize', updatePageHeight)
  window.visualViewport?.addEventListener('resize', updatePageHeight)
  document.addEventListener('visibilitychange', handleVoiceVisibilityChange)

  // Loading messages - scroll to the end as soon as the message arrives, without waiting for subsequent network requests
  await chatStore.loadMessages(friendChatId)

  // Wait for the DOM to update and scroll immediately after the page height takes effect.
  nextTick(() => {
    requestAnimationFrame(() => {
      // Force the scroll to the end for the first time (execute vs.scrollTo when opacity:0 is invisible to ensure that the last item is rendered into the DOM)
      scrollToBottom()
      // Wait another frame for the browser to apply scrollTop, and then display the content (what the user sees is the bottom and will not see the jump)
      requestAnimationFrame(() => {
        scrolled.value = true
        // Lightly align frame by frame after the content is visible (only scrollTop is set, vs.scrollTo() is not called),
        // Correct the slight deviation in the measured item height caused by virtual scrolling
        startRafNudge(30)
        // Start a 3-second nudge timer to cover bounces caused by asynchronous status updates (read receipts, online status, etc.)
        let nudgeCount = 0
        nudgeTimer = setInterval(() => {
          nudgeCount++
          if (nudgeCount > 20 || !isNearBottom()) {
            clearInterval(nudgeTimer)
            nudgeTimer = null
            return
          }
          nudgeToBottom()
        }, 150)
      })
    })
  })

  // The scheduled deletion check for disappearing after reading has been moved to the MainLayout application-level life cycle.
  // Ensure that the countdown continues after the user leaves the chat page and is deleted on time.

  // Align refreshes to the server's minute boundary. The watermark never falls back to device wall-clock time.
  refreshServerTime()

  // The following are asynchronous operations that do not affect the layout of the first screen and do not block scrolling:
  // Obtaining friend information, marking read, and synchronizing read receipts—these network requests take a long time.
  // But it will not change the message list height (only update the avatar/online status/read mark),
  // nudgeTimer automatically corrects possible small offsets after they trigger a reactive update.
  fetchFriendInfo()
  chatStore.markAsRead(friendChatId)
  chatStore.syncReadStatus(friendChatId)
})

onUnmounted(() => {
  chatPageUnmounted = true
  setSecureScreen(false)
  stopStatus && stopStatus()
  if (nowTimer) { clearTimeout(nowTimer); nowTimer = null }
  if (nudgeTimer) { clearInterval(nudgeTimer); nudgeTimer = null }
  if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null }
  pendingImageBottomIds.clear()
  measuredImageIds.clear()
  cancelRafNudge()
  if (heightResizeObserver) { heightResizeObserver.disconnect(); heightResizeObserver = null }
  window.removeEventListener('resize', updatePageHeight)
  window.visualViewport?.removeEventListener('resize', updatePageHeight)
  document.removeEventListener('visibilitychange', handleVoiceVisibilityChange)
  voicePointerHeld = false
  removeVoicePointerListeners()
  if (voiceRecording.value) finishVoiceRecording(true)
  else stopVoiceCaptureResources()
  if (voicePlayer) { voicePlayer.pause(); voicePlayer = null }
  selectedImages.value.forEach(disposeSelectedImage)
  selectedImages.value = []
  for (const timer of downloadResetTimers) clearTimeout(timer)
  downloadResetTimers.clear()
})

// Only monitor changes in the number of messages (new/deleted) to avoid deep traversal of the entire array.
// It also avoids unnecessary forced scrolling caused by changes in fields such as read receipts.
watch(() => messages.value.length, (newLength, oldLength) => {
  const newMsgs = messages.value
  const appended = newLength > oldLength ? newMsgs.slice(oldLength) : []
  const keepBottom = isNearBottom() || appended.some(message => message.mine)
  // Automatically scroll only when the user is already near the bottom, without interrupting when reviewing history
  if (keepBottom) {
    for (const message of appended) {
      if (isMsgImage(message)) pendingImageBottomIds.add(message.id)
    }
    nextTick(() => scrollToBottomReliable())
  }
  // Automatically mark new messages as read
  const unread = newMsgs.filter(m => !m.mine && !m.read)
  if (unread.length > 0) {
    chatStore.markAsRead(friendChatId)
  }
})

function onMessageImageSettled(message, index) {
  if (measuredImageIds.has(message.id)) return
  measuredImageIds.add(message.id)
  const keepBottom = pendingImageBottomIds.delete(message.id) || isNearBottom()
  // Image height is unknown until decoding completes. Ask QVirtualScroll to
  // replace its estimated item height with the actual rendered height.
  virtualScrollEl.value?.refresh?.(index)
  if (keepBottom) nextTick(() => scrollToBottomReliable(90))
}

/**
 * Obtain friend's public key through API (fallback)
 */
async function fetchFriendInfo() {
  try {
    const { data } = await friendApi.getFriends()
    const friend = data.find(f => f.chat_id === friendChatId)
    if (friend) {
      friendPubKey.value = friend.public_key
      identityStore.cacheFriendPubKey(friendChatId, friend.public_key)
      friendNickname.value = friend.nickname
      friendOnline.value = !!friend.online
    }
  } catch {
    $q.notify({ type: 'warning', message: t('chat.noPublicKey') })
  }
}

/**
 * Monitor friends’ online status changes
 */
function onStatusUpdate(callback) {
  function handler(payload) {
    // Security verification: check payload structure
    if (!payload || typeof payload.chat_id !== 'string' || typeof payload.online !== 'boolean') {
      console.warn('[ChatPage] invalid status payload:', payload)
      return
    }
    // Verify chat_id format
    if (!CHAT_ID_PATTERN.test(payload.chat_id)) {
      console.warn('[ChatPage] invalid chat_id in status:', payload.chat_id)
      return
    }
    callback(payload.chat_id, payload.online)
  }
  on('status', handler)
  return () => off('status', handler)
}

// ── File sending ───────────────────────────────────────────────

const IMAGE_REJECTION_KEYS = {
  not_image: 'imageRejectedType',
  file_size: 'imageRejectedSourceSize',
  duplicate: 'imageRejectedDuplicate',
  count: 'imageRejectedCount',
  total_size: 'imageRejectedTotalSize',
  invalid_metadata: 'imageRejectedType',
  output_size: 'imageRejectedOutputSize',
  dimensions_too_large: 'imageRejectedDimensions',
  compression_failed: 'imageCompressionFailed',
  compression_fallback: 'imageCompressionFallback',
}

function normalizedImageFile(file) {
  if (file.type) return file
  const inferredType = inferImageMimeType(file.name)
  if (!inferredType) return file
  return new File([file], file.name, {
    type: inferredType,
    lastModified: file.lastModified,
  })
}

function notifyImageRejections(rejected) {
  if (!rejected.length) return
  const counts = new Map()
  for (const item of rejected) {
    counts.set(item.reason, (counts.get(item.reason) || 0) + 1)
  }
  const details = [...counts.entries()].map(([reason, count]) => t(
    `chat.${IMAGE_REJECTION_KEYS[reason] || 'imageRejectedType'}`,
    {
      count,
      maxCount: MAX_IMAGE_SELECTION,
      maxSize: formatFileSize(MAX_IMAGE_FILE_BYTES),
      maxSource: formatFileSize(MAX_IMAGE_SOURCE_BYTES),
      maxTotal: formatFileSize(MAX_IMAGE_BATCH_BYTES),
    },
  ))
  $q.notify({
    type: 'warning',
    icon: 'image_not_supported',
    message: details.join(locale.value === 'zh-CN' ? '；' : '; '),
    timeout: 4200,
  })
}

function setImageSendMode(mode) {
  if (imageProcessing.value.active || imageBatch.value.sending) return
  imageSendMode.value = mode === 'original' ? 'original' : 'high_quality'
}

async function addSelectedImages(files) {
  const incoming = Array.from(files || [], normalizedImageFile)
  if (!incoming.length || imageProcessing.value.active || imageBatch.value.sending) return

  const existingByKey = new Map(selectedImages.value.map(item => [imageSelectionKey(item.originalFile), item]))
  const merged = mergeImageSelection(selectedImages.value.map(item => item.originalFile), incoming)
  const nextItems = []
  const rejected = [...merged.rejected]
  const newFiles = merged.files.filter(file => !existingByKey.has(imageSelectionKey(file)))

  morePanelOpen.value = false
  imageProcessing.value = { active: newFiles.length > 0, current: 0, total: newFiles.length }
  try {
    for (const file of merged.files) {
      const existing = existingByKey.get(imageSelectionKey(file))
      if (existing) {
        nextItems.push(existing)
        continue
      }
      if (chatPageUnmounted) break

      imageProcessing.value.current++
      try {
        const prepared = await compressImageForSending(file)
        if (prepared.file.size > MAX_IMAGE_FILE_BYTES) {
          rejected.push({ file, reason: 'output_size' })
          continue
        }
        chatStore.validateFile(prepared.file)
        nextItems.push({
          id: crypto.randomUUID(),
          originalFile: file,
          preparedFile: prepared.file,
          compressed: prepared.compressed,
          previewUrl: URL.createObjectURL(prepared.file),
        })
      } catch (error) {
        if (error?.code === 'dimensions_too_large') {
          rejected.push({ file, reason: 'dimensions_too_large' })
          continue
        }
        if (file.size <= MAX_IMAGE_FILE_BYTES) {
          try {
            chatStore.validateFile(file)
            nextItems.push({
              id: crypto.randomUUID(),
              originalFile: file,
              preparedFile: file,
              compressed: false,
              previewUrl: URL.createObjectURL(file),
            })
            rejected.push({ file, reason: 'compression_fallback' })
            continue
          } catch {
            // Fall through to the explicit compression failure below.
          }
        }
        rejected.push({ file, reason: 'compression_failed' })
      }
    }
  } finally {
    imageProcessing.value = { active: false, current: 0, total: 0 }
  }

  if (chatPageUnmounted) {
    nextItems.forEach(disposeSelectedImage)
    return
  }
  selectedImages.value = nextItems
  notifyImageRejections(rejected)
}

async function onImagesSelected(event) {
  const incoming = Array.from(event.target.files || [])
  event.target.value = ''
  await addSelectedImages(incoming)
}

async function onComposerPaste(event) {
  const incoming = extractClipboardImageFiles(event.clipboardData, {
    baseName: t('chat.clipboardScreenshotName'),
    timestamp: getCalibratedServerNow() ?? Date.now(),
  })
  if (!incoming.length) return

  // Clipboard images enter the same confirmation tray as gallery images.
  // Only image pastes are intercepted; text keeps the browser's native paste.
  event.preventDefault()
  if (imageProcessing.value.active || imageBatch.value.sending) {
    $q.notify({ type: 'warning', message: t('chat.imagePasteBusy') })
    return
  }
  await addSelectedImages(incoming)
}

function disposeSelectedImage(item) {
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
}

function removeSelectedImage(id) {
  if (imageBatch.value.sending || imageProcessing.value.active) return
  const index = selectedImages.value.findIndex(item => item.id === id)
  if (index < 0) return
  const [item] = selectedImages.value.splice(index, 1)
  disposeSelectedImage(item)
}

function clearSelectedImages() {
  if (imageBatch.value.sending || imageProcessing.value.active) return
  selectedImages.value.forEach(disposeSelectedImage)
  selectedImages.value = []
}

function consumeSelectedImage(id) {
  const index = selectedImages.value.findIndex(item => item.id === id)
  if (index < 0) return
  const [item] = selectedImages.value.splice(index, 1)
  disposeSelectedImage(item)
}

async function sendSelectedImages() {
  if (imageBatch.value.sending || imageProcessing.value.active || isTransferring.value || !selectedImages.value.length) return
  if (imageSendBlocked.value) {
    $q.notify({
      type: 'warning',
      message: t('chat.originalImageTooLarge', {
        count: originalOversizeCount.value,
        maxSize: formatFileSize(MAX_IMAGE_FILE_BYTES),
      }),
    })
    return
  }
  if (!friendPubKey.value) {
    $q.notify({ type: 'warning', message: t('chat.noPublicKey') })
    return
  }

  const queue = selectedImages.value.map(item => ({ ...item, file: selectedImageFile(item) }))
  const recipientKey = friendPubKey.value
  const batchId = crypto.randomUUID()
  const batchTotalBytes = queue.reduce((sum, item) => sum + item.file.size, 0)
  const burnAfterRead = burnMode.value
  let completed = 0
  let failed = false

  morePanelOpen.value = false
  imageBatch.value = {
    sending: true,
    id: batchId,
    current: 1,
    total: queue.length,
    completedBytes: 0,
    totalBytes: batchTotalBytes,
  }

  try {
    for (let index = 0; index < queue.length; index++) {
      if (chatPageUnmounted) break
      const item = queue[index]
      imageBatch.value.current = index + 1
      try {
        await chatStore.sendFile(
          friendChatId,
          recipientKey,
          item.file,
          burnAfterRead,
          { batchId, batchIndex: index, batchTotal: queue.length },
        )
        completed++
        imageBatch.value.completedBytes += item.file.size
        consumeSelectedImage(item.id)
      } catch (error) {
        failed = true
        consumeSelectedImage(item.id)
        if (!chatPageUnmounted) {
          $q.notify({
            type: 'negative',
            message: t('chat.imageBatchFailed', {
              name: item.file.name,
              error: error?.message || t('chat.unknownError'),
            }),
            timeout: 5000,
          })
        }
        break
      }
    }

    if (!failed && completed === queue.length && !chatPageUnmounted) {
      $q.notify({
        type: 'positive',
        icon: 'done_all',
        message: t('chat.imagesSent', { count: completed }),
        timeout: 1800,
      })
    }
  } finally {
    imageBatch.value = {
      sending: false,
      id: '',
      current: 0,
      total: 0,
      completedBytes: 0,
      totalBytes: 0,
    }
  }
}

function onFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''  //Allow repeated selection of the same file
  if (!file) return

  try {
    chatStore.validateFile(file)
  } catch (error) {
    $q.notify({ type: 'warning', message: attachmentFailureText(error, 'local'), timeout: 5000 })
    return
  }

  $q.dialog({
    title: t('chat.sendFileTitle'),
    message: t('chat.sendFileMessage', { name: file.name, size: formatFileSize(file.size) }),
    cancel: { label: t('common.cancel'), flat: true },
    ok: { label: t('chat.sendFile'), color: 'primary' },
    persistent: true
  }).onOk(() => doSendFile(file))
}

async function doSendFile(file) {
  if (!friendPubKey.value) {
    $q.notify({ type: 'warning', message: t('chat.noPublicKey') })
    return
  }
  try {
    await chatStore.sendFile(friendChatId, friendPubKey.value, file, burnMode.value)
  } catch (e) {
    $q.notify({ type: 'negative', message: t('chat.fileSendFailed', { error: attachmentFailureText(e, 'local') }) })
  }
}

// Maximum message length limit (to prevent DoS)
const MAX_MESSAGE_LENGTH = 10000

async function sendMsg(event) {
  // When pressing Enter to confirm the candidate word in Chinese and other input methods, sending cannot be triggered.
  if (event?.isComposing || event?.keyCode === 229) return
  const text = inputText.value.trim()
  if (!text) return
  // Security Check: Message Length Limit
  if (text.length > MAX_MESSAGE_LENGTH) {
    $q.notify({ type: 'warning', message: t('chat.messageTooLong', { count: MAX_MESSAGE_LENGTH }) })
    return
  }
  if (!friendPubKey.value) {
    $q.notify({ type: 'warning', message: t('chat.noPublicKey') })
    return
  }
  sending.value = true
  const pendingReply = replyTarget.value
  inputText.value = ''
  replyTarget.value = null
  try {
    const ok = await chatStore.sendMessage(
      friendChatId,
      friendPubKey.value,
      text,
      burnMode.value,
      pendingReply,
    )
    if (!ok) {
      $q.notify({ type: 'warning', message: t('chat.messageSendFailed') })
      inputText.value = text
      replyTarget.value = pendingReply
    }
  } catch (e) {
    $q.notify({ type: 'negative', message: t('chat.messageSendError', { error: e.message }) })
    inputText.value = text
    replyTarget.value = pendingReply
  } finally {
    sending.value = false
  }
}

async function retryMsg(msg) {
  if (retryingMessageId.value || !msg?.id) return
  if (!friendPubKey.value) {
    $q.notify({ type: 'warning', message: t('chat.noPublicKey') })
    return
  }
  retryingMessageId.value = msg.id
  try {
    const ok = msg.type === 'file' && msg.offlineAttachment
      ? await chatStore.retryOfflineFile(friendChatId, friendPubKey.value, msg.id)
      : await chatStore.retryMessage(friendChatId, friendPubKey.value, msg.id)
    if (!ok) {
      $q.notify({ type: 'warning', message: t('chat.queueFailed') })
    } else if (msg.status === 'queued') {
      $q.notify({ type: 'info', message: t('chat.queued') })
    }
  } catch (error) {
    $q.notify({ type: 'negative', message: t('chat.retryFailed', { error: attachmentFailureText(error) }) })
  } finally {
    retryingMessageId.value = null
  }
}

async function toggleOfflineTransfer(transfer) {
  if (!transfer?.id) return
  if (transfer.direction === 'receive') {
    if (transfer.status === 'paused' || transfer.status === 'error') {
      chatStore.resumeOfflineDownload(transfer.id)
    } else {
      chatStore.pauseOfflineDownload(transfer.id)
    }
    return
  }
  if (transfer.status === 'paused') {
    if (!friendPubKey.value) {
      $q.notify({ type: 'warning', message: t('chat.noPublicKey') })
      return
    }
    try {
      await chatStore.resumeOfflineTransfer(transfer.id, friendPubKey.value)
    } catch (error) {
      $q.notify({ type: 'negative', message: t('chat.retryFailed', { error: attachmentFailureText(error) }) })
    }
  } else {
    chatStore.pauseOfflineTransfer(transfer.id)
  }
}

function confirmCancelTransfer(transfer) {
  $q.dialog({
    title: t('chat.cancelTransferTitle'),
    message: t('chat.cancelTransferMessage'),
    cancel: true,
    persistent: true,
  }).onOk(async () => {
    try {
      await chatStore.cancelOfflineTransfer(transfer.id)
      $q.notify({ type: 'info', message: t('chat.transferCanceled') })
    } catch (error) {
      $q.notify({ type: 'negative', message: t('chat.actionFailed') })
    }
  })
}

function messageFailureText(msg) {
  const reasons = {
    invalid_recipient: t('chat.reasonInvalidRecipient'),
    invalid_payload: t('chat.reasonInvalidPayload'),
    not_friends: t('chat.reasonNotFriends'),
    message_id_conflict: t('chat.reasonIdConflict'),
    service_unavailable: t('chat.reasonServiceUnavailable'),
    temporary_failure: t('chat.reasonTemporaryFailure'),
    recipient_inbox_full: t('chat.reasonInboxFull'),
    client_error: t('chat.reasonClientError'),
    rejected: t('chat.reasonRejected')
  }
  if (msg?.failureCode && reasons[msg.failureCode]) return reasons[msg.failureCode]
  return msg?.status === 'queued'
    ? t('chat.waitingNetwork')
    : t('chat.failedRetry')
}

const RECALL_LIMIT_MS = 144 * 60 * 60 * 1000 //Can be withdrawn within 144 hours (6 days)

function canRecall(msg) {
  return Boolean(
    msg?.mine &&
    msg.status === 'sent' &&
    Number.isFinite(msg.ts) &&
    getServerNow() - msg.ts < RECALL_LIMIT_MS,
  )
}

function canReply(msg) {
  return Boolean(msg?.id && !msg.decryptionFailed)
}

function canCopy(msg) {
  return Boolean(msg?.type !== 'file' && typeof msg?.text === 'string' && !msg.decryptionFailed)
}

function canDeleteMessage(msg) {
  return Boolean(msg?.id && msg.status !== 'pending')
}

function messageReplyKind(msg) {
  if (msg.burnAfterRead) return 'burn'
  if (isMsgVoice(msg)) return 'voice'
  if (isMsgImage(msg)) return 'image'
  if (isMsgVideo(msg)) return 'video'
  if (msg.type === 'file') return 'file'
  return 'text'
}

function startReply(msg) {
  if (!canReply(msg)) return
  const kind = messageReplyKind(msg)
  const reply = normalizeReplyReference({
    messageId: msg.id,
    senderId: msg.mine ? identityStore.chatId : friendChatId,
    kind,
    preview: kind === 'text' ? msg.text : (msg.filename || ''),
  })
  if (!reply) return

  replyTarget.value = reply
  voiceInputMode.value = false
  morePanelOpen.value = false
  nextTick(() => inputEl.value?.focus?.())
}

function cancelReply() {
  replyTarget.value = null
}

function replySenderName(reply) {
  if (reply?.senderId === identityStore.chatId) return t('chat.you')
  if (reply?.senderId === friendChatId) return friendNickname.value
  return reply?.senderId || t('chat.unknownSender')
}

function replyPreviewText(reply) {
  if (!reply) return ''
  if (reply.kind === 'burn') return t('chat.burnMessage')
  if (reply.kind === 'voice') return t('chat.voiceMessage')
  if (reply.kind === 'image') return reply.preview || t('chat.imageMessage')
  if (reply.kind === 'video') return reply.preview || t('chat.videoMessage')
  if (reply.kind === 'file') return reply.preview || t('chat.fileMessage')
  return reply.preview || t('chat.originalUnavailable')
}

function scrollToRepliedMessage(reply) {
  const index = messages.value.findIndex(message => message.id === reply?.messageId)
  if (index < 0) {
    $q.notify({ type: 'info', message: t('chat.originalNotFound'), timeout: 1800 })
    return
  }

  highlightedMessageId.value = reply.messageId
  virtualScrollEl.value?.scrollTo(index, 'center-force')
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => {
    highlightedMessageId.value = null
    highlightTimer = null
  }, 1600)
}

async function copyMessage(msg) {
  if (!canCopy(msg)) return
  try {
    await copyToClipboard(msg.text)
    $q.notify({ type: 'positive', message: t('chat.messageCopied'), timeout: 1200 })
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: t('chat.copyFailed', { error: error?.message || t('chat.unknownError') }),
    })
  }
}

async function recall(msg) {
  if (!canRecall(msg)) return
  try {
    await chatStore.recallMessage(friendChatId, msg.id, friendChatId)
    $q.notify({ type: 'positive', message: t('chat.messageRecalled'), timeout: 1200 })
  } catch (error) {
    $q.notify({ type: 'negative', message: t('chat.actionFailed') })
  }
}

async function deleteMsg(msg) {
  if (!canDeleteMessage(msg)) return
  try {
    await chatStore.recallMessage(friendChatId, msg.id, null)
    $q.notify({ type: 'positive', message: t('chat.messageDeleted'), timeout: 1200 })
  } catch (error) {
    $q.notify({ type: 'negative', message: t('chat.actionFailed') })
  }
}

function clearHistory() {
  $q.dialog({
    title: t('chat.clearTitle'),
    message: t('chat.clearMessage', { name: friendNickname.value }),
    cancel: true,
    persistent: true
  }).onOk(async () => {
    await chatStore.clearChatMessages(friendChatId)
    $q.notify({ type: 'positive', message: t('chat.historyCleared') })
  })
}

// Dynamically calculate the height of q-page: Quasar QPage only sets min-height by default.
// Not giving height will cause the child elements of flex:1 (virtual scrolling) to be unable to obtain a certain height.
// This causes the entire page to scroll on the body and the last message to be obscured by the bottom bar.
// Accurately measure the actual height of q-header and q-footer (including dynamic elements such as breakage prompts),
// Subtract 100vh to get the exact height of the q-page.
function updatePageHeight() {
  const el = pageEl.value?.$el
  if (!el) return
  const header = document.querySelector('.q-header')
  const footer = document.querySelector('.q-footer')
  const headerH = header ? Math.round(header.getBoundingClientRect().height) : 0
  const footerH = footer ? Math.round(footer.getBoundingClientRect().height) : 0
  const viewportHeight = Math.round(window.visualViewport?.height || window.innerHeight)
  el.style.height = `${Math.max(0, viewportHeight - headerH - footerH)}px`
  // After height change, light alignment to avoid gaps if user is near the bottom
  if (isNearBottom()) nudgeToBottom()
}

function refreshServerTime() {
  now.value = getServerNow()
  watermarkNow.value = getCalibratedServerNow()
  const clock = watermarkNow.value ?? now.value
  const delayToNextMinute = 60000 - (Math.floor(clock) % 60000) + 50
  nowTimer = setTimeout(refreshServerTime, delayToNextMinute)
}

// Cancel the ongoing rAF nudge loop (used for cleanup when components are unloaded)
function cancelRafNudge() {
  if (rafNudgeId !== null) {
    cancelAnimationFrame(rafNudgeId)
    rafNudgeId = null
  }
}

// Start rAF frame-by-frame lightweight alignment (stop automatically after tries frames) for initial scrolling phase
function startRafNudge(tries = 30) {
  cancelRafNudge()
  const tick = (remaining) => {
    rafNudgeId = requestAnimationFrame(() => {
      rafNudgeId = null
      const el = virtualScrollEl.value?.$el
      if (!el || remaining <= 0) return
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      if (dist > 0) nudgeToBottom()
      tick(remaining - 1)
    })
  }
  tick(tries)
}

function scrollToBottom() {
  const vs = virtualScrollEl.value
  if (!vs || !messages.value.length) return
  // 1) Let the last item be rendered into the DOM first (virtual scrolling only renders the items in the viewport)
  vs.scrollTo(messages.value.length - 1, 'end-force')
  // 2) scrollTo can only align the end of the last item to the bottom of the viewport, and cannot scroll into the padding of the subsequent container;
  // Press directly to scrollHeight to stick to the real bottom
  const el = vs.$el
  if (el) el.scrollTop = el.scrollHeight
}

// Lightweight alignment: only set scrollTop, do not call vs.scrollTo(), and avoid triggering q-virtual-scroll
// Internal virtual position recalculation (recalculation will overwrite scrollTop in asynchronous frames, causing "bounce")
function nudgeToBottom() {
  const el = virtualScrollEl.value?.$el
  if (el) el.scrollTop = el.scrollHeight
}

// The virtual scrolling first screen is positioned according to the estimated height. After jumping to the bottom, each item will be corrected by actual measurement and there will be a deviation of "not touching the bottom".
// Use scrollToBottom() for the first time to let the last item enter rendering, and then use lightweight alignment correction frame by frame.
// No longer call vs.scrollTo() repeatedly to avoid triggering virtual scroll internal recalculation to overwrite scrollTop.
function scrollToBottomReliable(tries = 30) {
  scrollToBottom()
  startRafNudge(tries)
}

// Whether the user is at (nearly) the bottom: only in this case new messages will be automatically scrolled to avoid being forced back when looking back in history
function isNearBottom() {
  const el = virtualScrollEl.value?.$el
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 200
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' })
}

/**
 * Formatted countdown that will burn after reading
 */
function formatBurnCountdown(burnAt) {
  // Rely on responsive now to automatically refresh the countdown with the timer (do not change to Date.now())
  const remaining = burnAt - now.value
  if (remaining <= 0) return t('chat.deletingSoon')
  const hours = Math.floor(remaining / (60 * 60 * 1000))
  const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000))
  if (hours > 0) {
    return t('chat.deleteInHours', { hours, minutes })
  }
  return t('chat.deleteInMinutes', { minutes })
}

function burnCountdownText(msg) {
  if (Number.isFinite(msg?.burnAt)) return formatBurnCountdown(msg.burnAt)
  return msg?.mine ? t('chat.burnUnreadCompact') : t('chat.burnCountdownStartsOnRead')
}

/**
 * Compact display of continuous messages: hide avatars and reduce spacing
 */
function shouldCompact(msgs, idx) {
  if (idx === 0) return false
  const prev = msgs[idx - 1]
  const curr = msgs[idx]
  return prev.mine === curr.mine && (curr.ts - prev.ts) < 60000
}
</script>

<style scoped>
.chat-peer-bar {
  min-height: 50px;
  flex: 0 0 auto;
  background: rgba(255, 255, 255, 0.96);
  border-bottom: 1px solid #e7ebf0;
  box-shadow: 0 2px 8px rgba(31, 55, 78, 0.05);
}
.chat-peer-identity {
  min-width: 0;
  line-height: 1.2;
}
.chat-peer-name {
  overflow: hidden;
  color: #263238;
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-peer-id {
  margin-top: 2px;
  color: #8b96a3;
  font-size: 10px;
  letter-spacing: 0.35px;
}
.chat-message-area {
  position: relative;
  min-height: 0;
  overflow: hidden;
  isolation: isolate;
  background-color: #f8fafc;
  background-image: radial-gradient(circle at 1px 1px, rgba(25, 118, 210, 0.035) 1px, transparent 0);
  background-size: 18px 18px;
}
.chat-message-scroll {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}
.chat-watermark {
  position: absolute;
  z-index: 2;
  inset: -18%;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
  grid-auto-rows: 104px;
  column-gap: 32px;
  align-items: center;
  justify-items: center;
  overflow: hidden;
  transform: rotate(-18deg);
  transform-origin: center;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.chat-watermark span {
  color: #1565c0;
  opacity: 0.075;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.25px;
  white-space: nowrap;
}
.chat-watermark-burn span {
  color: #e65100;
  opacity: 0.16;
  font-weight: 700;
}
@media (max-width: 420px) {
  .chat-watermark {
    inset: -24% -42%;
    grid-template-columns: repeat(auto-fit, minmax(275px, 1fr));
    grid-auto-rows: 94px;
    column-gap: 28px;
  }
  .chat-watermark span {
    font-size: 11px;
  }
}
@media (min-width: 760px) {
  .chat-watermark {
    grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
    grid-auto-rows: 112px;
    column-gap: 40px;
  }
}
.avatar-placeholder {
  width: 28px;
  flex-shrink: 0;
}
.avatar-side {
  flex-shrink: 0;
  align-self: flex-start;
}
.emoji-item {
  display: inline-block;
  font-size: 22px;
  width: 36px;
  height: 36px;
  line-height: 36px;
  text-align: center;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s;
}
.emoji-item:hover {
  background: rgba(0, 0, 0, 0.08);
}
.burn-mode-status {
  min-height: 30px;
  padding: 3px 8px 3px 12px;
  display: flex;
  align-items: center;
  gap: 5px;
  color: #e65100;
  background: #fff3e0;
  border-top: 1px solid #ffe0b2;
  font-size: 12px;
}
.burn-mode-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}
.burn-mode-copy small {
  color: #bf360c;
  font-size: 10px;
}
.burn-countdown {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: #e65100;
  white-space: nowrap;
}
.burn-countdown-mine {
  color: #fff3e0;
}
.reply-composer-bar {
  min-height: 48px;
  padding: 5px 8px 5px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f7f9fc;
  border-top: 1px solid #e3e8ef;
}
.reply-composer-content {
  flex: 1;
  min-width: 0;
  padding-left: 8px;
  border-left: 3px solid #1976d2;
}
.reply-composer-title {
  color: #1565c0;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.25;
}
.reply-composer-preview {
  overflow: hidden;
  color: #616161;
  font-size: 12px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.image-selection-tray {
  flex: 0 0 auto;
  padding: 9px 10px 10px;
  background: #f8fafc;
  border-top: 1px solid #e2e8f0;
}
.image-selection-header,
.image-selection-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.image-selection-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #455a64;
  font-size: 12px;
  font-weight: 600;
}
.image-send-options {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.image-send-mode {
  display: inline-flex;
  padding: 2px;
  border-radius: 10px;
  background: #e7edf3;
}
.image-send-mode button {
  min-height: 27px;
  padding: 3px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #607d8b;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.image-send-mode button.active {
  background: #fff;
  color: #1565c0;
  font-weight: 650;
  box-shadow: 0 1px 4px rgba(38, 50, 56, 0.14);
}
.image-send-mode button:disabled {
  cursor: default;
  opacity: 0.6;
}
.image-original-warning {
  color: #c62828;
  font-size: 10px;
  line-height: 1.3;
}
.image-selection-list {
  margin: 7px -2px 8px;
  padding: 2px;
  display: flex;
  gap: 8px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}
.image-selection-item {
  position: relative;
  width: 68px;
  flex: 0 0 68px;
}
.image-selection-item img {
  width: 68px;
  height: 68px;
  display: block;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid #d9e2ec;
  background: #e9eef3;
}
.image-selection-remove {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 23px;
  height: 23px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 2px solid white;
  border-radius: 50%;
  background: #455a64;
  color: white;
  cursor: pointer;
}
.image-selection-name {
  margin-top: 3px;
  display: block;
  overflow: hidden;
  color: #78909c;
  font-size: 9px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.image-selection-size {
  display: block;
  color: #90a4ae;
  font-size: 9px;
  line-height: 1.2;
  text-align: center;
}
.image-selection-footer {
  color: #8794a1;
  font-size: 10px;
}
.image-batch-progress {
  color: #546e7a;
  font-size: 11px;
}
.image-batch-progress .q-linear-progress {
  height: 5px;
  margin-top: 5px;
}
.chat-composer {
  min-height: 54px;
  padding: 6px 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  border-top: 1px solid #e2e8f0;
  box-shadow: 0 -4px 12px rgba(31, 55, 78, 0.05);
}
.chat-composer :deep(.q-btn) {
  flex: 0 0 auto;
  min-width: 40px;
  min-height: 40px;
}
.composer-input,
.voice-hold-input {
  flex: 1 1 auto;
  min-width: 0;
}
.voice-hold-input {
  height: 40px;
  border: 1px solid #c7c7c7;
  border-radius: 20px;
  background: #fff;
  color: #333;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.voice-hold-input:active,
.voice-hold-input.recording {
  color: #1565c0;
  background: #e3f2fd;
  border-color: #90caf9;
}
.voice-hold-input:disabled {
  opacity: 0.55;
  cursor: default;
}
.composer-more-panel {
  min-height: 116px;
  padding: 13px 10px 16px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: start;
  gap: 6px;
  background: #f6f7f9;
  border-top: 1px solid #e5e5e5;
}
.composer-more-action {
  width: 100%;
  padding: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  border: 0;
  background: transparent;
  color: #444;
  font: inherit;
  cursor: pointer;
}
.composer-more-icon {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e0e0e0;
  border-radius: 14px;
  background: #fff;
  color: #555;
}
.composer-more-action small {
  color: #999;
  font-size: 10px;
  white-space: nowrap;
}
.composer-more-action.active,
.composer-more-action.active small,
.composer-more-action.active .composer-more-icon {
  color: #ef6c00;
}
.composer-more-action.active .composer-more-icon {
  border-color: #ffcc80;
  background: #fff3e0;
}
.composer-more-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.bubble-mine {
  background: #1976d2;
  color: white;
  border-radius: 16px 4px 16px 16px;
  max-width: min(78%, 560px);
  min-width: 0;
  overflow-wrap: anywhere;
  box-shadow: 0 2px 6px rgba(25, 118, 210, 0.14);
}
.bubble-theirs {
  background: #f0f0f0;
  color: #222;
  border-radius: 4px 16px 16px 16px;
  max-width: min(78%, 560px);
  min-width: 0;
  overflow-wrap: anywhere;
  box-shadow: 0 2px 6px rgba(38, 50, 56, 0.08);
}
.bubble-burn {
  border: 4px solid #ff9800;
}
.message-reply-quote {
  width: 100%;
  min-width: 130px;
  margin: 0 0 6px;
  padding: 5px 7px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 0;
  border-left: 3px solid currentColor;
  border-radius: 4px;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.message-reply-quote-theirs {
  color: #1565c0;
  background: rgba(25, 118, 210, 0.08);
}
.message-reply-quote-mine {
  color: #e3f2fd;
  background: rgba(255, 255, 255, 0.16);
}
.message-reply-author {
  font-size: 11px;
  font-weight: 700;
  line-height: 1.25;
}
.message-reply-preview {
  display: -webkit-box;
  overflow: hidden;
  opacity: 0.9;
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.message-target-highlight .bubble-mine,
.message-target-highlight .bubble-theirs {
  animation: message-target-pulse 1.5s ease-out;
}
@keyframes message-target-pulse {
  0%, 35% { box-shadow: 0 0 0 4px rgba(255, 152, 0, 0.5); }
  100% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0); }
}
.read-status {
  font-size: 11px;
  line-height: 1;
  min-width: 14px;
  letter-spacing: -1px;
  font-weight: bold;
}
.file-img {
  width: auto;
  max-width: 100%;
  max-height: min(42vh, 360px);
  border-radius: 10px;
  display: block;
  object-fit: contain;
  background: rgba(0, 0, 0, 0.04);
  cursor: zoom-in;
}
.file-video {
  max-width: 100%;
  border-radius: 8px;
  display: block;
}
.file-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  min-width: 180px;
  max-width: min(100%, 320px);
}
.file-card-mine {
  background: rgba(255,255,255,0.18);
}
.file-card-theirs {
  background: rgba(0,0,0,0.06);
}
.file-icon {
  font-size: 28px;
  flex-shrink: 0;
}
.file-meta {
  flex: 1;
  min-width: 0;
}
.file-name {
  font-size: 13px;
  font-weight: 500;
  word-break: break-all;
  line-height: 1.3;
}
.file-size {
  font-size: 11px;
  opacity: 0.65;
  margin-top: 2px;
}
.file-dl {
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: rgba(25, 118, 210, 0.12);
  color: #1565c0;
  flex-shrink: 0;
  cursor: pointer;
}
.file-dl-mine {
  background: rgba(255,255,255,0.2);
  color: white;
}
.file-dl.complete {
  color: #2e7d32;
  background: rgba(76, 175, 80, 0.15);
}
.file-dl:disabled {
  cursor: wait;
  opacity: 0.7;
}
.file-download-status {
  margin-top: 4px;
  font-size: 10px;
  line-height: 1.2;
  opacity: 0.78;
}
.file-download-progress {
  height: 3px;
  margin-bottom: 3px;
}
.file-expired {
  font-size: 11px;
  opacity: 0.5;
  flex-shrink: 0;
}
.message-retry-icon {
  cursor: pointer;
}
.voice-message {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 145px;
  border: 0;
  padding: 7px 9px;
  border-radius: 10px;
  font: inherit;
  cursor: pointer;
}
.voice-message:disabled {
  cursor: default;
  opacity: 0.55;
}
.voice-message-mine {
  color: white;
  background: rgba(255,255,255,0.16);
}
.voice-message-theirs {
  color: #222;
  background: rgba(0,0,0,0.06);
}
.voice-message-wave {
  flex: 1;
  letter-spacing: -1px;
  opacity: 0.8;
  white-space: nowrap;
}
.voice-record-button {
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.voice-record-overlay {
  position: fixed;
  inset: 0;
  z-index: 6000;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  background: rgba(0, 0, 0, 0.18);
}
.voice-record-card {
  width: 220px;
  min-height: 170px;
  padding: 22px 18px;
  border-radius: 18px;
  background: rgba(25, 118, 210, 0.95);
  color: white;
  text-align: center;
  box-shadow: 0 10px 36px rgba(0,0,0,0.28);
}
.voice-record-overlay.cancelling .voice-record-card {
  background: rgba(211, 47, 47, 0.95);
}
.voice-record-time {
  margin-top: 8px;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}
.voice-levels {
  height: 42px;
  margin: 10px 0 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
}
.voice-levels span {
  display: block;
  width: 4px;
  min-height: 4px;
  border-radius: 3px;
  background: white;
  transition: height 0.08s linear;
}
.voice-record-hint {
  font-size: 13px;
  opacity: 0.92;
}
</style>
