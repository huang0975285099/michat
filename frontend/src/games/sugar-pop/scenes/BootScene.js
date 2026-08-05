import { candyTextures } from '../assets/candies.js'
import Scene from 'phaser/src/scene/Scene.js'

const TEXTURE_KEYS = {
  striped: 'special-striped',
  wrapped: 'special-wrapped',
  colorBomb: 'special-color-bomb',
  jelly: 'obstacle-jelly',
  frosting: 'obstacle-frosting',
}

export default class BootScene extends Scene {
  constructor() {
    super({ key: 'BootScene' })
  }

  preload() {
    for (const [key, data] of Object.entries(candyTextures)) {
      const textureKey = TEXTURE_KEYS[key] || `candy-${key}`
      if (!this.textures.exists(textureKey)) this.load.image(textureKey, data)
    }
  }

  create() {
    this.scene.start('MapScene')
  }
}
