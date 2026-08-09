export async function acquireCallMedia(mediaDevices, options) {
  const stream = await mediaDevices.getUserMedia({ audio: true, video: false })
  if (!options.video) return { stream, videoError: null }

  try {
    const cameraStream = await mediaDevices.getUserMedia({
      audio: false,
      video: { ...options.videoConstraints, facingMode: options.facingMode },
    })
    const videoTrack = cameraStream.getVideoTracks()[0]
    if (!videoTrack) {
      cameraStream.getTracks().forEach((track) => track.stop())
      throw Object.assign(new Error('camera returned no video track'), { name: 'NotFoundError' })
    }
    stream.addTrack(videoTrack)
    cameraStream.getTracks()
      .filter((track) => track !== videoTrack)
      .forEach((track) => track.stop())
    return { stream, videoError: null }
  } catch (videoError) {
    return { stream, videoError }
  }
}
