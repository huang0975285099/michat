const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function encodeBase64(value) {
  let encoded = ''
  for (let index = 0; index < value.length; index += 3) {
    const first = value.charCodeAt(index)
    const second = value.charCodeAt(index + 1)
    const third = value.charCodeAt(index + 2)
    const triplet = (first << 16) | ((Number.isNaN(second) ? 0 : second) << 8) | (Number.isNaN(third) ? 0 : third)
    encoded += BASE64[(triplet >> 18) & 63]
    encoded += BASE64[(triplet >> 12) & 63]
    encoded += Number.isNaN(second) ? '=' : BASE64[(triplet >> 6) & 63]
    encoded += Number.isNaN(third) ? '=' : BASE64[triplet & 63]
  }
  return encoded
}

const svgData = (body) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`
  return `data:image/svg+xml;base64,${encodeBase64(svg)}`
}

export const candyTextures = {
  berry: svgData(`
    <path d="M50 13C34 13 22 28 25 45 16 55 22 77 38 81c8 10 24 10 32 0 16-4 22-26 13-36C86 28 69 13 50 13Z" fill="#e94878" stroke="#9f1f4d" stroke-width="5"/>
    <path d="M29 31c9-12 29-18 43-3" fill="none" stroke="#ffb7cb" stroke-width="7" stroke-linecap="round"/>
    <g fill="#ff8eb1"><circle cx="37" cy="48" r="5"/><circle cx="56" cy="42" r="5"/><circle cx="66" cy="61" r="5"/><circle cx="43" cy="67" r="5"/></g>`),
  lemon: svgData(`
    <ellipse cx="50" cy="50" rx="38" ry="29" fill="#f8d84c" stroke="#bf8c15" stroke-width="5" transform="rotate(-25 50 50)"/>
    <path d="M21 63 78 36M29 75 71 25" stroke="#fff3a7" stroke-width="6" stroke-linecap="round"/>
    <ellipse cx="41" cy="38" rx="11" ry="5" fill="#fff8c6" opacity=".8" transform="rotate(-25 41 38)"/>`),
  mint: svgData(`
    <rect x="17" y="17" width="66" height="66" rx="24" fill="#5bcf9a" stroke="#167552" stroke-width="5"/>
    <path d="M50 21c13 10 13 22 0 29-13-7-13-19 0-29Zm29 29c-10 13-22 13-29 0 7-13 19-13 29 0ZM50 79C37 69 37 57 50 50c13 7 13 19 0 29ZM21 50c10-13 22-13 29 0-7 13-19 13-29 0Z" fill="#d9fff0"/>
    <circle cx="50" cy="50" r="7" fill="#2d9f74"/>`),
  grape: svgData(`
    <path d="M49 15c-8 3-13 8-16 17 8 2 17-1 22-9" fill="#77b84a" stroke="#38722c" stroke-width="4"/>
    <g fill="#8054c7" stroke="#4b2c83" stroke-width="4"><circle cx="39" cy="39" r="16"/><circle cx="61" cy="39" r="16"/><circle cx="30" cy="59" r="16"/><circle cx="50" cy="61" r="17"/><circle cx="70" cy="59" r="16"/><circle cx="50" cy="78" r="15"/></g>
    <g fill="#c9b0ff"><circle cx="35" cy="35" r="4"/><circle cx="57" cy="35" r="4"/><circle cx="46" cy="56" r="4"/></g>`),
  orange: svgData(`
    <path d="M50 13 75 27 84 52 70 76 43 86 18 70 14 43 29 20Z" fill="#ff9f37" stroke="#bd571e" stroke-width="5"/>
    <path d="M28 66c11 8 33 10 46-2M28 38c12-9 32-10 46 1" fill="none" stroke="#ffd27e" stroke-width="6" stroke-linecap="round"/>
    <circle cx="38" cy="47" r="5" fill="#fff0c9"/><circle cx="62" cy="55" r="5" fill="#fff0c9"/>`),
  swirl: svgData(`
    <circle cx="50" cy="50" r="38" fill="#65a7f3" stroke="#2356a5" stroke-width="5"/>
    <path d="M74 35c-11-14-36-11-43 4-8 17 10 33 25 25 13-7 6-24-7-22-10 2-10 15 0 17" fill="none" stroke="#f8fbff" stroke-width="8" stroke-linecap="round"/>
    <circle cx="50" cy="59" r="4" fill="#2356a5"/>`),
  striped: svgData(`
    <rect x="14" y="14" width="72" height="72" rx="27" fill="#f06b6b" stroke="#a52c45" stroke-width="5"/>
    <path d="M20 35h60M16 50h68M20 65h60" stroke="#fff2d3" stroke-width="8"/>
    <path d="M28 25c8-8 28-8 36 0" fill="none" stroke="#ffc1c1" stroke-width="5"/>`),
  wrapped: svgData(`
    <path d="M50 12 79 28 87 56 68 81 35 85 14 60 20 29Z" fill="#d468e6" stroke="#772c91" stroke-width="5"/>
    <path d="M50 22v57M22 50h56M30 30l40 40M70 30 30 70" stroke="#ffd5fb" stroke-width="5" stroke-linecap="round"/>
    <circle cx="50" cy="50" r="10" fill="#fff0fe"/>`),
  colorBomb: svgData(`
    <circle cx="50" cy="50" r="38" fill="#2f3b59" stroke="#12192d" stroke-width="5"/>
    <g fill="#fff"><circle cx="36" cy="35" r="7"/><circle cx="60" cy="31" r="7"/><circle cx="69" cy="51" r="7"/><circle cx="53" cy="69" r="7"/><circle cx="31" cy="60" r="7"/></g>
    <circle cx="36" cy="35" r="3" fill="#ef4c66"/><circle cx="60" cy="31" r="3" fill="#f7ce45"/><circle cx="69" cy="51" r="3" fill="#62cf91"/><circle cx="53" cy="69" r="3" fill="#68a8f6"/><circle cx="31" cy="60" r="3" fill="#ad70e5"/>`),
  jelly: svgData(`<rect x="12" y="12" width="76" height="76" rx="20" fill="#7cd7f0" fill-opacity=".5" stroke="#c9f8ff" stroke-width="5"/><path d="M23 58c15-15 39-15 54 0" fill="none" stroke="#e8feff" stroke-width="5"/>`),
  frosting: svgData(`<rect x="13" y="18" width="74" height="64" rx="13" fill="#f2e9db" stroke="#b79c87" stroke-width="5"/><path d="M18 45h64M22 64h56" stroke="#fffaf0" stroke-width="7"/><circle cx="34" cy="31" r="4" fill="#c8ad96"/><circle cx="64" cy="58" r="4" fill="#c8ad96"/>`),
}

export const candyTextureKeys = Object.keys(candyTextures)
