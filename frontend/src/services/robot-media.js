const ROBOT_MEDIA_PATH = /^\/api\/robot\/media\/[a-f0-9]{32}\.(?:jpg|png|gif|webp|mp4|webm)$/
const CONTENT_MEDIA_SRC = /(<(?:img|video)\s+src=")(\/api\/robot\/media\/[a-f0-9]{32}\.(?:jpg|png|gif|webp|mp4|webm))(")/g

// Uploaded article media uses site-relative paths. Native app pages have their
// own origin, so the paths must use the same server origin as the API.
export function robotMediaUrl(path, apiBaseUrl) {
  if (typeof path !== 'string' || !ROBOT_MEDIA_PATH.test(path)) return path
  const origin = String(apiBaseUrl || '').replace(/\/api\/?$/, '')
  return `${origin}${path}`
}

export function resolveRobotContentMedia(html, apiBaseUrl) {
  if (typeof html !== 'string') return ''
  return html.replace(CONTENT_MEDIA_SRC, (_match, before, path, after) => (
    `${before}${robotMediaUrl(path, apiBaseUrl)}${after}`
  ))
}
