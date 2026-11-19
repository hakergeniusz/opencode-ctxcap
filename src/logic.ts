/**
 * Pure helpers for opencode-ctxcap.
 *
 * No OpenCode SDK imports here on purpose: the capping math, argument parsing
 * and state normalization are unit-testable without a running OpenCode host.
 */

export const COMMAND = "ctxcap"
export const DEFAULT_MIN_CAP_TOKENS = 32_768

export interface ModelCap {
  /** Pristine context window, snapshotted before any cap was applied. */
  original: number
  /** Applied cap as a percent of `original` (slider/percent currency). */
  percent?: number
  /** Applied cap as an absolute token budget (from `200k`-style args). */
  tokens?: number
}

export interface CapState {
  models: Record<string, ModelCap>
}

/** What the user asked for: a percent of the original window or absolute tokens. */
export type CapRequest = { percent: number | null } | { tokens: number }

export type ParseResult = CapRequest | { error: string }

export function emptyState(): CapState {
  return { models: {} }
}

export function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

/** A stored entry is "capped" only when it carries a real percent or token budget. */
export function isCapped(entry: ModelCap | undefined): boolean {
  return (
    !!entry &&
    (entry.tokens !== undefined || (entry.percent !== undefined && entry.percent !== null))
  )
}

/** Rebuild a usable state from an untrusted JSON value read from plugin storage. */
export function normalizeState(value: unknown): CapState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState()
  const models = (value as Record<string, unknown>).models
  if (!models || typeof models !== "object" || Array.isArray(models)) return emptyState()

  const out = emptyState()
  for (const [key, raw] of Object.entries(models as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const original =
      typeof entry.original === "number" && Number.isFinite(entry.original) && entry.original > 0
        ? entry.original
        : undefined
    if (!original) continue
    const cap: ModelCap = { original }
    if (typeof entry.percent === "number" && Number.isFinite(entry.percent)) {
      cap.percent = entry.percent
    }
    if (typeof entry.tokens === "number" && Number.isFinite(entry.tokens)) {
      cap.tokens = entry.tokens
    }
    out.models[key] = cap
  }
  return out
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

/** Convert a stored cap entry back into the request form used by `capFor`. */
export function requestFromEntry(entry: ModelCap): CapRequest | undefined {
  if (entry.tokens !== undefined) return { tokens: entry.tokens }
  if (entry.percent !== undefined && entry.percent !== null) return { percent: entry.percent }
  return undefined
}

/** Resolve the effective context window for a request, applying the safety floor. */
export function capFor(original: number, request: CapRequest, minCap: number): number {
  const asked =
    "tokens" in request
      ? request.tokens
      : request.percent === null
        ? original
        : Math.round((original * request.percent) / 100)
  return Math.max(minCap, asked)
}

/** Parse `/ctxcap` arguments. Mirrors the original pi extension's grammar. */
export function parseCapArg(arg: string, original: number): ParseResult {
  const trimmed = arg.trim().toLowerCase()
  if (trimmed === "off" || trimmed === "reset" || trimmed === "none") return { percent: null }

  const pct = trimmed.match(/^(\d+(?:\.\d+)?)\s*%$/)
  if (pct) {
    const v = Number(pct[1])
    if (!Number.isFinite(v) || v <= 0 || v > 100) {
      return { error: `percentage must be 1..100, got "${arg}"` }
    }
    return { percent: Math.round(v) }
  }

  const abs = trimmed.match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/)
  if (abs) {
    const mult = abs[2] === "k" ? 1_000 : abs[2] === "m" ? 1_000_000 : 1
    const tokens = Math.round(Number(abs[1]) * mult)
    if (!Number.isFinite(tokens) || tokens <= 0) return { error: `bad token budget "${arg}"` }
    if (tokens < original * 0.01) {
      return { error: `${fmt(tokens)} tokens is under 1% of ${fmt(original)}` }
    }
    return { tokens: Math.min(tokens, original) }
  }

  return { error: `usage: /${COMMAND} [percent | tokens | off] — e.g. 50%, 200k, off` }
}

export function usageText(minCap: number): string {
  return [
    `Usage: /${COMMAND} [percent | tokens | off]`,
    `  /${COMMAND}        show the current cap (interactive slider was pi-only)`,
    `  /${COMMAND} 50%    cap at a percent of the model's original window`,
    `  /${COMMAND} 200k   cap at an absolute token budget (k/m suffixes ok)`,
    `  /${COMMAND} off    lift the cap (also: reset, none)`,
    `Caps are clamped to a ${fmt(minCap)}-token floor.`,
  ].join("\n")
}
