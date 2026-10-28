// Evidence written by these scripts is committed to a public repository, so every absolute path that
// belongs to one machine is replaced before it is serialized. Anything else is left exactly as
// measured: redaction must never turn a failed step into a passing one.
import { homedir } from 'node:os'

const repoRoot = new URL('..', import.meta.url).pathname

const replacements = [
  [repoRoot.endsWith('/') ? repoRoot.slice(0, -1) : repoRoot, '<repo>'],
  [homedir(), '<home>'],
]

function scrub(text) {
  let out = text
  for (const [from, to] of replacements) {
    if (from !== '' && from !== '/') out = out.split(from).join(to)
  }
  return out.replace(/\/(?:private\/)?var\/folders\/[^"'\\\s,]+/g, '<tmp>')
}

export function redact(value) {
  if (typeof value === 'string') return scrub(value)
  if (Array.isArray(value)) return value.map(redact)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = redact(item)
    return out
  }
  return value
}

export function redactedJson(value) {
  return `${JSON.stringify(redact(value), null, 2)}\n`
}
