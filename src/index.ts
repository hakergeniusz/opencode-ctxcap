/**
 * opencode-ctxcap — cap a model's effective context window so compaction
 * engages earlier and long sessions stop re-reading huge cached contexts.
 *
 * Native OpenCode V2 rewrite of `pi-ctxcap`. The cap is applied through
 * `ctx.model.transform` by lowering `Model.Info.limit.context` for every model
 * that has a stored cap. Per-model choices are persisted with `ctx.storage` and
 * re-applied automatically whenever OpenCode rebuilds the model registry
 * (startup, model switch, explicit reload).
 */

import { Plugin } from "@opencode/plugin"
import {
  COMMAND,
  DEFAULT_MIN_CAP_TOKENS,
  capFor,
  fmt,
  isCapped,
  modelKey,
  normalizeState,
  parseCapArg,
  requestFromEntry,
  usageText,
  type CapState,
} from "./logic"

const STORAGE_KEY = "ctxcap.state"

/** Session.Info.model in the OpenCode API is a { providerID, modelID } ref. */
interface ModelRef {
  providerID: string
  modelID: string
}

export default Plugin.define({
  id: "ctxcap",
  async setup(ctx) {
    // Optional override, e.g. via `{ "package": "opencode-ctxcap", "options": { "minCap": 65536 } }`.
    const optionMin = ctx.options?.minCap
    const minCap =
      typeof optionMin === "number" && Number.isFinite(optionMin) && optionMin > 0
        ? Math.round(optionMin)
        : DEFAULT_MIN_CAP_TOKENS

    // Load persisted caps once; transforms are synchronous, so they read this
    // in-memory mirror. A command updates both the mirror and storage, then
    // calls ctx.model.reload() to replay the transform.
    let state: CapState = normalizeState(await ctx.storage.get(STORAGE_KEY))

    const persist = async () => {
      await ctx.storage.set(STORAGE_KEY, state)
    }

    // Core behavior: cap the effective context window of each capped model.
    await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        const key = modelKey(model.providerID, model.id)
        const entry: any = state.models[key]
        if (!isCapped(entry) || !(entry.original > 0)) continue
        const request = requestFromEntry(entry)
        if (!request) continue
        const capped = capFor(entry.original, request, minCap)
        editor.update(model.providerID, model.id, (draft: any) => {
          if (!draft.limit) return
          draft.limit.context = capped
        })
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND,
        description: "Cap a model's effective context window so compaction engages earlier",
        execute: async ({ sessionID, prompt }) => {
          const reply = async (text: string) => {
            await ctx.session.synthetic({ sessionID, text })
          }

          // Defensive: normally prompt.text is just the argument string after
          // the command name; tolerate a full "/ctxcap ..." form as well.
          let arg = (prompt.text ?? "").trim()
          if (arg.toLowerCase().startsWith(`/${COMMAND}`)) {
            arg = arg.slice(COMMAND.length + 1).trim()
          }

          try {
            if (arg === "-h" || arg === "--help" || arg === "help") {
              await reply(usageText(minCap))
              return
            }

            const session: any = await ctx.session.get({ sessionID })
            const ref = session?.model as ModelRef | undefined
            if (!ref?.providerID || !ref?.modelID) {
              await reply("ctxcap: no model is selected for this session")
              return
            }

            const listed: any = (await ctx.model.list()).find(
              (m: any) => m.providerID === ref.providerID && m.id === ref.modelID,
            )
            const currentContext: number = listed?.limit?.context ?? 0
            if (!currentContext) {
              await reply("ctxcap: the selected model has no known context window")
              return
            }

            const key = modelKey(ref.providerID, ref.modelID)
            const stored = state.models[key]
            // When a cap already exists, `original` is the stable snapshot;
            // otherwise the current (uncapped) window is pristine.
            const original = stored?.original && stored.original > 0 ? stored.original : currentContext
            const label = `${ref.providerID}/${ref.modelID}`

            // No argument: report status. (The pi interactive slider has no
            // server-side equivalent; see README "Known gaps".)
            if (arg === "") {
              if (!isCapped(stored)) {
                await reply(
                  `ctxcap: no cap set for ${label}; context window is ${fmt(original)} tokens.\n${usageText(minCap)}`,
                )
              } else {
                const request = requestFromEntry(stored)!
                const capped = capFor(original, request, minCap)
                const pct =
                  "tokens" in request ? Math.round((capped / original) * 100) : request.percent!
                await reply(
                  `ctxcap: ${label} capped at ${fmt(capped)} / ${fmt(original)} tokens (${pct}%).\n${usageText(minCap)}`,
                )
              }
              return
            }

            const parsed = parseCapArg(arg, original)
            if ("error" in parsed) {
              await reply(`ctxcap: ${parsed.error}\n${usageText(minCap)}`)
              return
            }

            const uncapped = "percent" in parsed && parsed.percent === null
            if (uncapped) {
              // Keep the original snapshot but drop the cap.
              state.models[key] = { original }
            } else if ("tokens" in parsed) {
              state.models[key] = { original, tokens: parsed.tokens }
            } else {
              state.models[key] = { original, percent: parsed.percent! }
            }

            await persist()
            await ctx.model.reload()

            if (uncapped) {
              await reply(`ctxcap: cap lifted — full ${fmt(original)} tokens restored for ${label}`)
            } else {
              const capped = capFor(original, parsed, minCap)
              const pct = "tokens" in parsed ? Math.round((capped / original) * 100) : parsed.percent!
              await reply(
                `ctxcap: ${label} context window capped at ${fmt(capped)} / ${fmt(original)} tokens (${pct}%)`,
              )
            }
          } catch (err) {
            // Never break a session over cap bookkeeping.
            const message = err instanceof Error ? err.message : String(err)
            await reply(`ctxcap: failed to apply cap (${message})`).catch(() => {})
          }
        },
      })
    })

    // No explicit session_start/model_select hooks are needed: model transforms
    // replay from persisted state whenever the registry is rebuilt.
  },
})
