export const THRESHOLDS = Object.freeze({ orange: 40, red: 70 })

export function percent(pressure) {
  const tokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  const window = pressure?.contextWindow
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0 || tokens < 0) return null
  return Math.min(100, Math.round(tokens / window * 100))
}

export function band(value) {
  return value >= THRESHOLDS.red ? 'red' : value >= THRESHOLDS.orange ? 'orange' : 'neutral'
}

export function clickDecision(draft, busy) {
  if (busy || typeof draft !== 'string') return 'disabled'
  return draft === '' ? 'submit' : 'refuse'
}

export function isBusy(status, input) {
  return status?.running !== false || status.pendingInteraction != null ||
    input?.phase !== 'plain' || !Array.isArray(input?.attachmentIds) || input.attachmentIds.length > 0
}
