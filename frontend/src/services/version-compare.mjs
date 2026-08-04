const VERSION_PATTERN = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function parseNumericIdentifier(value, source) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) {
    throw new TypeError(`Invalid version: ${source}`)
  }
  return number
}

function parseVersion(value) {
  const source = String(value ?? '').trim()
  const match = VERSION_PATTERN.exec(source)
  if (!match) throw new TypeError(`Invalid version: ${source || '<empty>'}`)

  return {
    core: [match[1], match[2] ?? '0', match[3] ?? '0']
      .map((part) => parseNumericIdentifier(part, source)),
    prerelease: match[4] ? match[4].split('.') : null,
  }
}

function comparePrerelease(a, b) {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1

  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    if (a[index] === undefined) return -1
    if (b[index] === undefined) return 1
    if (a[index] === b[index]) continue

    const aIsNumeric = /^\d+$/.test(a[index])
    const bIsNumeric = /^\d+$/.test(b[index])
    if (aIsNumeric && bIsNumeric) {
      const aNumber = parseNumericIdentifier(a[index], a.join('.'))
      const bNumber = parseNumericIdentifier(b[index], b.join('.'))
      return aNumber > bNumber ? 1 : -1
    }
    if (aIsNumeric !== bIsNumeric) return aIsNumeric ? -1 : 1
    return a[index] > b[index] ? 1 : -1
  }
  return 0
}

// SemVer comparison: a>b returns 1, a<b returns -1, equality returns 0.
// A leading "v" and omitted minor/patch components are accepted for compatibility.
export function cmpVersion(a, b) {
  const parsedA = parseVersion(a)
  const parsedB = parseVersion(b)

  for (let index = 0; index < parsedA.core.length; index++) {
    if (parsedA.core[index] === parsedB.core[index]) continue
    return parsedA.core[index] > parsedB.core[index] ? 1 : -1
  }
  return comparePrerelease(parsedA.prerelease, parsedB.prerelease)
}

export function getUpdateStatus(current, latest, minSupported = '') {
  if (minSupported && cmpVersion(current, minSupported) < 0) return 'required'
  if (latest && cmpVersion(current, latest) < 0) return 'available'
  return 'current'
}
