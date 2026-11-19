# opencode-ctxcap

A native **OpenCode V2** plugin that caps a model's effective context window so
auto-compaction engages earlier and long sessions stop re-sending huge cached
contexts. It is a rewrite of the pi extension [`pi-ctxcap`](https://github.com/hakergeniusz/pi-ctxcap).

## Why

On big-window models (1M+ tokens) the compaction trigger is effectively
unreachable, so a marathon session re-sends the whole accumulated context on
every turn. `/ctxcap` lowers the window OpenCode sees, moving the compaction
trigger to where you actually want it and keeping the context meter honest.

## Usage

```text
/ctxcap            show the current cap and usage
/ctxcap 50%        cap at half of the model's original window
/ctxcap 200k       cap at an absolute token budget (k/m suffixes work)
/ctxcap off        lift the cap (also: reset, none, 100% not needed — off)
/ctxcap --help     print usage
```

The cap applies immediately: the plugin edits `Model.Info.limit.context` for
the selected model and calls `ctx.model.reload()`, so no restart or config edit
is needed. Feedback is delivered as a short synthetic message in the session
(server commands have no direct TUI notification API).

Caps are clamped to a **32,768-token floor** so compaction reserve and
keep-recent budgets still have headroom. The original window is snapshotted the
first time a cap is stored, so percentages stay stable across sessions.

## How it maps from the pi original

| pi concept | OpenCode V2 equivalent used here |
| --- | --- |
| Mutate live `model.contextWindow` | `ctx.model.transform` → `editor.update(...).limit.context` + `ctx.model.reload()` |
| `pi.registerCommand("/ctxcap")` | `ctx.command.transform` → `editor.add({ name: "ctxcap", ... })` |
| `~/.pi/agent/ctxcap.json` persistence | `ctx.storage.get/set` under key `ctxcap.state` |
| `session_start` / `model_select` re-apply | Model transforms replay from persisted state on every registry rebuild (startup, model switch, reload) — no explicit hooks needed |
| `ctx.ui.notify` / `setStatus` | Short `ctx.session.synthetic` messages (no server-side toast/status API) |

The pure logic (argument parsing, cap math, state normalization) lives in
`src/logic.ts` with no SDK imports so it is unit-testable.

## Load

Local directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/hakergeniusz/Projects/opencode-ctxcap"]
}
```

Or, once published:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-ctxcap"]
}
```

## Options

Passed with the plugin object form:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-ctxcap",
      "options": { "minCap": 65536 }
    }
  ]
}
```

- `minCap` (number, default `32768`) — lower bound for any cap.

## Caveats / known gaps

- **Interactive TUI slider not ported.** The pi extension opened a custom
  arrow-key slider for the no-argument command. OpenCode server commands have
  no interactive widget API; reproducing it would require a separate TUI part
  plus cross-part RPC. `/ctxcap` with no argument now reports the current cap
  and usage instead. Argument-based capping is fully preserved.
- **Set the cap before the context grows past it.** Once the context exceeds
  the cap, outgoing `max_tokens` may be starved until compaction recovers.
- Compaction timing itself is OpenCode's own logic; this plugin only moves the
  window number it reads.
- Persistence is scoped to OpenCode's plugin storage for the current location,
  not a shared home-directory JSON file.

## Test

The original smoke test was not carried over verbatim because it drove a fake
pi host with pi-only APIs. Pure logic tests are included instead:

```sh
bun test/logic.test.ts
```

## License

MIT — copyright 2026 hakergeniusz.
