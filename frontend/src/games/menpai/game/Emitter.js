// 门派 PK · 梦幻西游风 - 极简 EventEmitter
// 不依赖 Phaser，BattleEngine（纯逻辑层，可单测）与 BattleFeed 共用。

export class Emitter {
  constructor() { this._h = new Map() }

  on(e, fn) {
    (this._h.get(e) || this._h.set(e, []).get(e)).push(fn)
    return this
  }

  off(e, fn) {
    const a = this._h.get(e)
    if (a) this._h.set(e, a.filter((f) => f !== fn))
    return this
  }

  emit(e, ...args) {
    (this._h.get(e) || []).forEach((fn) => fn(...args))
    return this
  }
}
