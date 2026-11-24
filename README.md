# pi-turn-fold

Fold one pi agent turn into a single clickable row.

```
 用 bash 跑 5 条命令…

 ▸ took 12s · 6 calls · bash×6 · 1 failed

 五条命令各自执行完毕。
```

Click the row to show what it replaced (the tool rows, groups and intermediate
messages drawn by [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)),
marked with a `│` gutter, click again to fold it back.

Sub-calls a tool reports in its own result (pi's codemode `details.calls`) are
counted under it: `codemode×1 (bash×3 read×2)`.

Commands:

```
/fold turn last   toggle the newest folded turn (or /fold turn 3)
/fold on          fold turns again
/fold off         unfold everything, stop folding new turns
```

Folds survive a restart: each one is appended to the session, and a reopened
session re-applies them after the transcript is rendered.

## Install

```bash
pi install /path/to/pi-turn-fold
# or try it without touching settings:
pi -e /path/to/pi-turn-fold/extensions/index.ts
```

## How it works

pi has no message-level renderer, so the extension caps
`InteractiveMode.prototype.addMessageToChat` to capture the live `chatContainer`,
then on `agent_settled`:

1. finds the turn's `UserMessageComponent` and the final text reply,
2. hides every component in between (`render()` → `[]`),
3. splices a `SummaryLine` + two spacers directly under the user message.

The summary row is a real child of the chat container, which is what makes clicks
work: pi dispatches mouse events over the component tree, not over rendered text.
Hiding components instead of rebuilding the turn keeps pi-cc-extensions' grouping,
diff rendering and footers intact when the row is expanded.

Failed and interrupted turns fold too; the summary says `1 failed` for a tool that
errored and `1 nested failed` for a sub-call that failed inside a tool's own result,
and expanding still shows the error rows verbatim.

## Status

Stage S3 done. Not done: folding while a turn is still running (only settled turns
fold).

Known edges:

- A reopened turn always comes back collapsed; an expanded restore paints a stale
  first frame, so the expanded state is not restored.
- Click coordinates must be read off the screen right before clicking: expanding a
  turn above the row you want shifts it.

## Dev

```bash
npm test        # node --test, 15 checks
npm run typecheck
```
