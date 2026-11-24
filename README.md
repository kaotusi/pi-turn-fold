# pi-turn-fold

Fold one pi agent turn into a single clickable row.

```
 用 bash 跑 5 条命令…

 ▸ took 12s · 6 calls · bash×6 · 1 failed

 五条命令各自执行完毕。
```

Click the row to show what it replaced (the tool rows, groups and intermediate
messages drawn by [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)),
click again to fold it back.

## Install

```bash
pi install /path/to/pi-turn-fold
# or try it without touching settings:
pi -e /path/to/pi-turn-fold/extensions/index.ts
```

## How it works

pi has no message-level renderer, so the extension caps
`InteractiveMode.prototype.addMessageToChat` to capture the live `chatContainer`,
then on `agent_settled` (completed runs only):

1. finds the turn's `UserMessageComponent` and the final text reply,
2. hides every component in between (`render()` → `[]`),
3. splices a `SummaryLine` + two spacers directly under the user message.

The summary row is a real child of the chat container, which is what makes clicks
work: pi dispatches mouse events over the component tree, not over rendered text.
Hiding components instead of rebuilding the turn keeps pi-cc-extensions' grouping,
diff rendering and footers intact when the row is expanded.

Failed and interrupted turns are never folded, so error rows stay visible.

## Status

Stage S1. Not done yet: persistence across restarts (S2), `/fold turn [N|last]` and
`/fold on|off` commands, an expand-time `│` gutter, live-turn folding (S3).

## Dev

```bash
npm test        # node --test, 9 checks
npm run typecheck
```
