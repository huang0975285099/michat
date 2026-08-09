export function videoCallStatusText({
  state,
  connectionStatus,
  reconnectSeconds,
  peerName,
  remoteVideoOn,
  hasRemoteVideoTrack,
}) {
  if (connectionStatus === 'reconnecting') {
    return `Network outage，Recovering（${reconnectSeconds}seconds）`
  }
  if (state === 'calling') return `Calling ${peerName}...`
  if (connectionStatus === 'connecting') return 'Establishing secure connection...'
  if (remoteVideoOn === false) return 'The other party is currently using voice only'
  if (!hasRemoteVideoTrack) return 'Waiting for the other party video...'
  return ''
}
