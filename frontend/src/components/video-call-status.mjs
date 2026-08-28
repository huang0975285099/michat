export function videoCallStatusText({
  state,
  connectionStatus,
  reconnectSeconds,
  peerName,
  remoteVideoOn,
  hasRemoteVideoTrack,
  translate,
}) {
  if (translate) {
    if (connectionStatus === 'reconnecting') return translate('call.reconnecting', { seconds: reconnectSeconds })
    if (state === 'calling') return translate('call.calling', { name: peerName })
    if (connectionStatus === 'connecting') return translate('call.connecting')
    if (remoteVideoOn === false) return translate('call.peerVoiceOnly')
    if (!hasRemoteVideoTrack) return translate('call.waitingVideo')
    return ''
  }
  if (connectionStatus === 'reconnecting') {
    return `Network outage，Recovering（${reconnectSeconds}seconds）`
  }
  if (state === 'calling') return `Calling ${peerName}...`
  if (connectionStatus === 'connecting') return 'Establishing secure connection...'
  if (remoteVideoOn === false) return 'The other party is currently using voice only'
  if (!hasRemoteVideoTrack) return 'Waiting for the other party video...'
  return ''
}
