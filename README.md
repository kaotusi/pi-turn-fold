# pi-turn-fold

Fold one pi agent turn into a single clickable row — while it runs, not afterwards.

```
 用 bash 跑 5 条命令…

 ▸ working · 12s · 4 calls · bash×3 · read×1

 五条命令各自执行完毕。

 ▸ took 14s · 6 calls · bash×6 · 1 failed
```

The row is live: process rows are hidden as they arrive, the clock and call counts
move, and when the turn settles the row locks to `took …` and the final reply is
released underneath it.

Click the row to show what it replaced (the tool rows, groups and intermediate
messages drawn by [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)),
marked with a `│` gutter, click again to fold it back. An expanded turn stays
expanded for the rest of that turn; the extension never folds it back on its own.

Sub-calls a tool reports in its own result (pi's codemode `details.calls`) are
counted under it: `codemode×1 (bash×3 read×2)`.

Commands:

```
/fold turn last   toggle the newest folded turn (or /fold turn 3)
/fold on          fold turns again
/fold off         unfold everything, stop folding new turns
```

Folds survive a restart: each one is appended to the session, and a reopened
session re-applies them after the transcript is rendered. `/fold off` mid-turn
releases the live row and stops folding; `/fold on` starts again with the next turn.

## Install

```bash
pi install github.com/kaotusi/pi-turn-fold
# or try it without touching settings:
pi -e /path/to/pi-turn-fold/extensions/index.ts
```

## How it works

pi has no message-level renderer and tool rows are built outside the message path,
so the extension caps three seams on `InteractiveMode.prototype`:

- `addMessageToChat` — to learn which components the turn added,
- `renderSessionItems` — to re-apply folds when a session is reopened,
- plus `tool_execution_start`/`tool_execution_end` for the live counts.

On `before_agent_start` it creates a live record and a `SummaryLine`, and from then
on:

1. every component the turn adds is hidden the moment it is added (`render()` → `[]`),
2. the summary row is spliced in above them, under the user message,
3. a 500 ms tick re-sweeps the container (streaming text and cc rows bypass the
   message hook) and marks the row dirty — nothing invalidates inside a frame,
4. on `agent_settled` the row locks to `took …`, the final reply is shown, and the
   whole thing is appended to the session.

The summary row is a real child of the chat container, which is what makes clicks
work: pi dispatches mouse events over the component tree, not over rendered text.
Hiding components instead of rebuilding the turn keeps pi-cc-extensions' grouping,
diff rendering and footers intact when the row is expanded.

Failed and interrupted turns fold too; the summary says `1 failed` for a tool that
errored and `1 nested failed` for a sub-call that failed inside a tool's own result,
and expanding still shows the error rows verbatim.

## Status

Stage S4 done: turns fold while they run.

Known edges:

- The live row advances on a 500 ms tick, so a count can lag a fast tool by half a
  second; the clock is cached per second.
- A turn with no tool calls is not folded — it has nothing to hide.
- A reopened turn always comes back collapsed; an expanded restore paints a stale
  first frame, so the expanded state is not restored.
- Click coordinates must be read off the screen right before clicking: expanding a
  turn above the row you want shifts it.

## Dev

```bash
npm test        # node --test, 24 checks
npm run typecheck
```
