import { candyTextures } from '../assets/candies.js'
import Scene from 'phaser/src/scene/Scene.js'

const TEXTURE_KEYS = {
  striped: 'special-striped',
  wrapped: 'special-wrapped',
  colorBomb: 'special-color-bomb',
  jelly: 'obstacle-jelly',
  frosting: 'obstacle-frosting',
}

function loadSvgImage(data) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to rasterize Sugar Pop SVG texture'))
    image.src = data
  })
}

export function createBootScene(SceneBase) {
  return class BootScene extends SceneBase {
    constructor() {
      super({ key: 'BootScene' })
    }

    async registerTextures() {
      await Promise.all(Object.entries(candyTextures).map(async ([key, data]) => {
        const textureKey = TEXTURE_KEYS[key] || `candy-${key}`
        if (this.textures.exists(textureKey)) return
        const image = await loadSvgImage(data)
        this.textures.createCanvas(textureKey, 100, 100).draw(0, 0, image)
      }))
    }

    async create() {
      await this.registerTextures()
      this.scene.start('MapScene')
    }
  }
}

export default createBootScene(Scene)
