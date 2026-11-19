/**
 * Pure-logic tests for opencode-ctxcap. No OpenCode SDK or pi runtime needed.
 * Run: `bun test/logic.test.ts`
 */

import assert from "node:assert/strict"
import {
  DEFAULT_MIN_CAP_TOKENS,
  capFor,
  isCapped,
  modelKey,
  normalizeState,
  parseCapArg,
  requestFromEntry,
  usageText,
} from "../src/logic.ts"

const ORIGINAL = 1_048_576
const KEY = modelKey("nvidia", "nemotron-3.5-super")

let passed = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
  } catch (err) {
    console.error(`FAIL: ${name}`)
    throw err
  }
}

check("modelKey is provider/model", () => {
  assert.equal(KEY, "nvidia/nemotron-3.5-super")
})

check("parse 50%", () => {
  assert.deepEqual(parseCapArg("50%", ORIGINAL), { percent: 50 })
})

check("parse absolute 200k", () => {
  assert.deepEqual(parseCapArg("200k", ORIGINAL), { tokens: 200_000 })
})

check("parse 1m and m suffix", () => {
  assert.deepEqual(parseCapArg("1m", ORIGINAL), { tokens: Math.min(1_000_000, ORIGINAL) })
})

check("parse off/reset/none", () => {
  assert.deepEqual(parseCapArg("off", ORIGINAL), { percent: null })
  assert.deepEqual(parseCapArg("reset", ORIGINAL), { percent: null })
  assert.deepEqual(parseCapArg("NONE", ORIGINAL), { percent: null })
})

check("reject over-100% and bad percentages", () => {
  assert.ok("error" in parseCapArg("150%", ORIGINAL))
  assert.ok("error" in parseCapArg("0%", ORIGINAL))
})

check("reject bogus and sub-1% budgets", () => {
  assert.ok("error" in parseCapArg("bogus", ORIGINAL))
  assert.ok("error" in parseCapArg("1", ORIGINAL))
})

check("percent cap math", () => {
  assert.equal(capFor(ORIGINAL, { percent: 50 }, DEFAULT_MIN_CAP_TOKENS), Math.round(ORIGINAL / 2))
  assert.equal(capFor(ORIGINAL, { percent: 25 }, DEFAULT_MIN_CAP_TOKENS), Math.round(ORIGINAL / 4))
})

check("absolute cap math", () => {
  assert.equal(capFor(ORIGINAL, { tokens: 200_000 }, DEFAULT_MIN_CAP_TOKENS), 200_000)
})

check("tiny caps clamp to the floor", () => {
  assert.equal(capFor(ORIGINAL, { percent: 1 }, DEFAULT_MIN_CAP_TOKENS), 32_768)
  assert.equal(capFor(ORIGINAL, { tokens: 100 }, 50_000), 50_000)
})

check("off restores the original window", () => {
  assert.equal(capFor(ORIGINAL, { percent: null }, DEFAULT_MIN_CAP_TOKENS), ORIGINAL)
})

check("isCapped ignores uncapped/off entries", () => {
  assert.equal(isCapped(undefined), false)
  assert.equal(isCapped({ original: ORIGINAL }), false)
  assert.equal(isCapped({ original: ORIGINAL, percent: null }), false)
  assert.equal(isCapped({ original: ORIGINAL, percent: 50 }), true)
  assert.equal(isCapped({ original: ORIGINAL, tokens: 200_000 }), true)
})

check("requestFromEntry prefers tokens", () => {
  assert.deepEqual(requestFromEntry({ original: ORIGINAL, tokens: 200_000, percent: 50 }), {
    tokens: 200_000,
  })
  assert.deepEqual(requestFromEntry({ original: ORIGINAL, percent: 50 }), { percent: 50 })
  assert.equal(requestFromEntry({ original: ORIGINAL }), undefined)
})

check("normalizeState sanitizes stored values", () => {
  const state = normalizeState({
    models: {
      [KEY]: { original: ORIGINAL, percent: 50, tokens: "oops" },
      bad: { original: -1, percent: 10 },
      alsoBad: "nope",
    },
  })
  assert.deepEqual(state.models[KEY], { original: ORIGINAL, percent: 50 })
  assert.equal(state.models.bad, undefined)
  assert.equal(state.models.alsoBad, undefined)
})

check("normalizeState tolerates garbage", () => {
  assert.deepEqual(normalizeState(undefined), { models: {} })
  assert.deepEqual(normalizeState({ models: null }), { models: {} })
})

check("usage text mentions the floor", () => {
  assert.match(usageText(DEFAULT_MIN_CAP_TOKENS), /32,768/)
})

console.log(`\n${passed} passed, 0 failed`)
