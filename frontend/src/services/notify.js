/**
 * 消息提醒工具
 * - 仅任务栏闪烁（Electron），不弹系统 Toast
 */

export function notifyNewMessage() {
  if (window.myAPI?.flashWindow) {
    window.myAPI.flashWindow()
  }
}
