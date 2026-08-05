import Phaser from 'phaser'
import { candyTextures } from '../assets/candies.js'

export default class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene')
  }

  preload() {
    for (const [key, data] of Object.entries(candyTextures)) {
      if (!this.textures.exists(key)) this.load.image(key, data)
    }
  }

  create() {
    this.scene.start('MapScene')
  }
}
