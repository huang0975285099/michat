import Scene from 'phaser/src/scene/Scene.js'
import OverlayView from '../ui/OverlayView.js'

export function createOverlayScene(SceneBase) {
  return class OverlayScene extends SceneBase {
    constructor() {
      super({ key: 'OverlayScene' })
    }

  create() {
    this.handleResize = this.handleResize.bind(this)
    this.scale.on('resize', this.handleResize)
    this.events.once('shutdown', this.shutdown, this)
  }

  open({ kind, payload = {}, onAction }) {
    this.current = { kind, payload, onAction }
    this.view?.destroy()
    this.view = new OverlayView(this)
    this.view.render({ kind, payload, onAction: (action) => this.handleAction(action) })
  }

  async handleAction(action) {
    if (this.actionPending || !this.current) return
    this.actionPending = true
    try {
      const close = await this.current.onAction?.(action)
      if (close !== false) this.close()
    } finally {
      this.actionPending = false
    }
  }

  close() {
    this.view?.destroy()
    this.view = null
    this.current = null
  }

  handleResize() {
    if (this.current) this.open(this.current)
  }

    shutdown() {
      this.scale.off('resize', this.handleResize)
      this.close()
    }
  }
}

export default createOverlayScene(Scene)
