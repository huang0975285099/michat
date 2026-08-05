const fallbackPhaser = {
  AUTO: 0,
  Scale: { RESIZE: 5 },
}

export function createSugarPopConfig(parent, phaser = fallbackPhaser, scene = []) {
  return {
    type: phaser.AUTO,
    parent,
    width: '100%',
    height: '100%',
    scale: {
      mode: phaser.Scale.RESIZE,
      width: '100%',
      height: '100%',
    },
    audio: { noAudio: true },
    scene,
  }
}
