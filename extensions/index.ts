import { AssistantMessageComponent, InteractiveMode, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Container } from "@earendil-works/pi-tui";
import { foldInterval, lastUserIndex, type FoldRecord, type FoldResult, type FoldableComponent, type Fg, type SummaryLine } from "./fold.ts";

const HOOK = Symbol.for("pi-turn-fold.chat-hook");
const HOOK_RENDER = Symbol.for("pi-turn-fold.render-hook");
const TURN_ENTRY = "pi-turn-fold.turn";
const OPTIONS_ENTRY = "pi-turn-fold.options";

interface Ui {
	theme?: { fg?: (color: string, text: string) => string };
	requestRender?(force?: boolean): void;
}

interface Fold {
	summary: SummaryLine;
	hidden: FoldableComponent[];
	record: FoldRecord;
}

interface FoldState {
	chat?: Container;
	ui?: Ui;
	runStart?: number;
	outcome?: string;
	foldsEnabled: boolean;
	folds: Map<number, Fold>;
}

const state: FoldState = { foldsEnabled: true, folds: new Map() };

function warn(message: string, error?: unknown): void {
	console.warn(`[pi-turn-fold] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`);
}

function rememberUi(ui: Ui | undefined): void {
	if (ui) state.ui = { ...state.ui, ...ui };
}

function fg(): Fg {
	const theme = state.ui?.theme;
	const colorize = theme?.fg?.bind(theme);
	return (color, text) => {
		if (!colorize) return text;
		try {
			return colorize(color, text);
		} catch {
			return text;
		}
	};
}

/**
 * pi exposes no message-level renderer, so the chat container is captured by wrapping
 * InteractiveMode.addMessageToChat — the only place that knows the live container.
 */
type ChatHost = { chatContainer?: Container; sessionManager?: { getBranch?(): readonly unknown[] } };

type AddMessageToChat = ((this: ChatHost, message: unknown, options?: unknown) => void) & {
	[HOOK]?: boolean;
};

type RenderSessionItems = ((this: ChatHost, items: unknown, meta?: unknown, options?: unknown) => void) & {
	[HOOK_RENDER]?: boolean;
};

function installChatHook(): boolean {
	// SAFETY: the class is a real constructor; only its prototype surface is read, member by member.
	const proto = (InteractiveMode as unknown as { prototype?: Record<string, unknown> })?.prototype;
	const original = proto?.addMessageToChat as AddMessageToChat | undefined;
	if (typeof original !== "function") {
		warn("InteractiveMode.addMessageToChat not found; turn folding disabled");
		return false;
	}
	if (!proto) return false;
	if (original[HOOK]) return true;
	const wrapped: AddMessageToChat = function (this: { chatContainer?: Container }, message, options) {
		if (this?.chatContainer) state.chat = this.chatContainer;
		original.call(this, message, options);
	};
	wrapped[HOOK] = true;
	proto.addMessageToChat = wrapped;
	return true;
}

/**
 * A resumed session renders the transcript through InteractiveMode.renderSessionItems, so the
 * folds are re-applied right after that render — the one point where every message is attached.
 */
function installRenderHook(pi: ExtensionAPI): boolean {
	// SAFETY: the class is a real constructor; only its prototype surface is read, member by member.
	const proto = (InteractiveMode as unknown as { prototype?: Record<string, unknown> })?.prototype;
	const original = proto?.renderSessionItems as RenderSessionItems | undefined;
	if (typeof original !== "function") {
		warn("InteractiveMode.renderSessionItems not found; saved folds cannot be restored");
		return false;
	}
	if (!proto) return false;
	if (original[HOOK_RENDER]) return true;
	const wrapped: RenderSessionItems = function (this: ChatHost, items, meta, options) {
		original.call(this, items, meta, options);
		try {
			restore(pi, this.sessionManager?.getBranch?.());
		} catch (error) {
			warn("restore failed", error);
		}
	};
	wrapped[HOOK_RENDER] = true;
	proto.renderSessionItems = wrapped;
	return true;
}

function persist(pi: ExtensionAPI, record: FoldRecord): void {
	try {
		pi.appendEntry(TURN_ENTRY, record);
	} catch (error) {
		warn("could not persist fold", error);
	}
}

/**
 * Repaint outside the current frame: a request made while pi is composing a frame is swallowed and
 * the screen keeps the older layout (rows spliced in by a fold never show up).
 */
function rerender(): void {
	setTimeout(() => {
		try {
			state.chat?.invalidate?.();
			state.ui?.requestRender?.(true);
		} catch (error) {
			warn("could not repaint", error);
		}
	}, 0);
}

/** Fold one turn and remember it, so `/fold turn N` and a reopened session can find it. */
function foldAndTrack(pi: ExtensionAPI, input: Parameters<typeof foldInterval>[0]): FoldResult | undefined {
	const holder: { fold?: Fold } = {};
	const result = foldInterval({
		...input,
		onToggle: (expanded) => {
			if (holder.fold) {
				holder.fold.record.expanded = expanded;
				persist(pi, holder.fold.record);
			}
			rerender();
		},
	});
	if (!result) return undefined;
	holder.fold = { summary: result.summary, hidden: result.hidden, record: result.record };
	state.folds.set(result.record.ordinal, holder.fold);
	persist(pi, result.record);
	return result;
}

function settle(pi: ExtensionAPI, aborted: boolean, outcome: string | undefined): void {
	const children = state.chat?.children as FoldableComponent[] | undefined;
	const ms = state.runStart === undefined ? undefined : Date.now() - state.runStart;
	state.runStart = undefined;
	if (!Array.isArray(children) || !state.foldsEnabled) return;
	foldAndTrack(pi, {
		children,
		userIndex: lastUserIndex(children, UserMessageComponent),
		ToolClass: ToolExecutionComponent,
		AssistantClass: AssistantMessageComponent,
		UserClass: UserMessageComponent,
		ms,
		outcome: aborted ? "aborted" : outcome,
		fg: fg(),
	});
	rerender();
}

/** Re-apply the folds a previous session left in the branch, newest last. */
function restore(pi: ExtensionAPI, branch: readonly unknown[] | undefined): void {
	const children = state.chat?.children as FoldableComponent[] | undefined;
	if (!Array.isArray(children) || !Array.isArray(branch)) return;
	const records = new Map<number, FoldRecord>();
	let foldsEnabled = true;
	for (const item of branch) {
		const entry = item as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom") continue;
		if (entry.customType === OPTIONS_ENTRY) foldsEnabled = (entry.data as { folds?: boolean } | undefined)?.folds !== false;
		if (entry.customType !== TURN_ENTRY) continue;
		const record = entry.data as FoldRecord | undefined;
		if (record && typeof record.ordinal === "number" && Array.isArray(record.tools)) records.set(record.ordinal, record);
	}
	state.foldsEnabled = foldsEnabled;
	state.folds.clear();
	// newest turn first: splicing a summary earlier never moves a later turn's user message
	for (const record of [...records.values()].sort((left, right) => right.ordinal - left.ordinal)) {
		const userIndices = (children as FoldableComponent[]).flatMap((component, index) => (component instanceof UserMessageComponent ? [index] : []));
		const userIndex = userIndices[record.ordinal];
		if (userIndex === undefined) continue;
		foldAndTrack(pi, {
			children,
			userIndex,
			ToolClass: ToolExecutionComponent,
			AssistantClass: AssistantMessageComponent,
			UserClass: UserMessageComponent,
			ms: record.ms,
			outcome: record.outcome,
			tools: record.tools,
			// shortcut: reopened turns always start collapsed; an expanded restore paints a stale
			// first frame (pi composes it while we are still folding), upgrade when pi exposes a
			// repaint that lands after the current frame.
			expanded: false,
			fg: fg(),
		});
	}
	rerender();
}

function runCommand(pi: ExtensionAPI, args: string): void {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const target = words[0] === "turn" ? words[1] : words[0];
	if (target === "on" || target === "off") {
		state.foldsEnabled = target === "on";
		pi.appendEntry(OPTIONS_ENTRY, { folds: state.foldsEnabled });
		for (const fold of state.folds.values()) fold.summary.setExpanded(!state.foldsEnabled);
		return;
	}
	const folds = [...state.folds.values()].sort((left, right) => left.record.ordinal - right.record.ordinal);
	const fold = target === undefined || target === "last" ? folds.at(-1) : folds[Number(target) - 1];
	fold?.summary.setExpanded(!fold.summary.expanded);
}

export default function piTurnFold(pi: ExtensionAPI): void {
	if (!installChatHook()) return;
	installRenderHook(pi);

	pi.registerCommand("fold", {
		description: "Fold turn transcripts: /fold turn [N|last], /fold on|off",
		handler: async (args) => {
			try {
				runCommand(pi, args);
			} catch (error) {
				warn("command failed", error);
			}
		},
	});

	const reload = (ctx: { ui?: unknown }): void => {
		// SAFETY: ctx.ui is pi's extension UI; only theme.fg and requestRender are read, both guarded below.
		rememberUi(ctx.ui as Ui | undefined);
		installChatHook();
	};

	pi.on("session_start", (_event, ctx) => reload(ctx));

	pi.on("session_tree", (_event, ctx) => reload(ctx));

	pi.on("agent_start", () => {
		state.runStart = Date.now();
		state.outcome = undefined;
	});

	pi.on("agent_before_settle", (event) => {
		state.outcome = event.outcome;
	});

	pi.on("agent_settled", (event, ctx) => {
		rememberUi(ctx.ui as Ui);
		const outcome = state.outcome;
		// let pi attach the last components before rewriting the container
		setTimeout(() => {
			try {
				settle(pi, event.aborted, outcome);
			} catch (error) {
				warn("fold failed", error);
			}
		}, 0);
	});
}

