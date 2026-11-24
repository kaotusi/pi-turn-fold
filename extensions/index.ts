import { appendFileSync } from "node:fs";
import { AssistantMessageComponent, InteractiveMode, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Spacer } from "@earendil-works/pi-tui";
import type { Container } from "@earendil-works/pi-tui";
import {
	applyHidden,
	foldInterval,
	hideComponent,
	isFinalReply,
	lastUserIndex,
	nestedFailures,
	nestedTools,
	railComponent,
	showComponent,
	SummaryLine,
	unrailComponent,
	type FoldRecord,
	type FoldResult,
	type FoldableComponent,
	type Fg,
	type ToolEntry,
} from "./fold.ts";

const HOOK = Symbol.for("pi-turn-fold.chat-hook");
const HOOK_RENDER = Symbol.for("pi-turn-fold.render-hook");
const HOOK_ADD_CHILD = Symbol.for("pi-turn-fold.add-child-hook");
const HOOK_PAINT = Symbol.for("pi-turn-fold.paint-hook");
const TURN_ENTRY = "pi-turn-fold.turn";
const OPTIONS_ENTRY = "pi-turn-fold.options";

interface Ui {
	theme?: { fg?: (color: string, text: string) => string };
	requestRender?(force?: boolean): void;
}

interface Fold {
	summary: SummaryLine;
	record: FoldRecord;
}

/** A run that is still going: its process components are hidden as they arrive, behind one live row. */
interface Live {
	ordinal: number;
	userIndex: number;
	startedAt: number;
	outcome: string;
	calls: Map<string, ToolEntry>;
	summary: SummaryLine;
	hidden: Set<FoldableComponent>;
	record: FoldRecord;
	inserted: boolean;
	expanded: boolean;
	reply?: FoldableComponent;
	timer?: ReturnType<typeof setInterval>;
}

interface FoldState {
	chat?: Container;
	ui?: Ui;
	runStart?: number;
	outcome?: string;
	foldsEnabled: boolean;
	folds: Map<number, Fold>;
	live?: Live;
}

const state: FoldState = { foldsEnabled: true, folds: new Map() };

const DEBUG_LOG = process.env.PI_TURN_FOLD_DEBUG;

/** `PI_TURN_FOLD_DEBUG=1` (or a path) traces components, rows and splices; the detail thunk stays unsampled otherwise. */
function debug(event: string, detail?: () => Record<string, unknown>): void {
	if (!DEBUG_LOG) return;
	try {
		appendFileSync(DEBUG_LOG === "1" ? "/tmp/pi-turn-fold-debug.log" : DEBUG_LOG, `${Date.now()} ${event}${detail ? ` ${JSON.stringify(detail())}` : ""}\n`);
	} catch {
		// tracing must never break the run
	}
}

function nameOf(component: FoldableComponent | undefined): string {
	// SAFETY: every FoldableComponent is an object; the constructor name is only read for tracing.
	return (component as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? String(component);
}

function rowsOf(component: FoldableComponent | undefined): number {
	try {
		return component?.render(120).length ?? 0;
	} catch {
		return -1;
	}
}

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

type AddChildHook = ((this: Container, child: unknown) => void) & { [HOOK_ADD_CHILD]?: boolean };

type PaintHook = ((this: Container, width: number) => readonly string[]) & { [HOOK_PAINT]?: boolean };

/**
 * The live row is spliced right under this turn's user message, before any process row exists, so the
 * first frame already reads as one folded turn.
 */
function insertSummary(live: Live, children: FoldableComponent[]): boolean {
	if (live.inserted || live.userIndex < 0) return false;
	children.splice(live.userIndex + 1, 0, new Spacer(1), live.summary, new Spacer(1));
	live.inserted = true;
	state.folds.set(live.record.ordinal, { summary: live.summary, record: live.record });
	debug("summary-inserted", () => ({ ordinal: live.record.ordinal, userIndex: live.userIndex }));
	return true;
}

/**
 * pi attaches the turn's user message and then starts the run, so the row can be placed at
 * before_agent_start. Anything else as the last child means the message is still on its way and the
 * addChild hook places the row instead.
 */
function attachSummary(live: Live): void {
	const children = state.chat?.children as FoldableComponent[] | undefined;
	if (!Array.isArray(children)) return;
	if (live.userIndex < 0) {
		const last = children[children.length - 1];
		if (!(last instanceof UserMessageComponent)) return;
		live.userIndex = children.length - 1;
		live.ordinal = children.filter((component) => component instanceof UserMessageComponent).length - 1;
		live.record.ordinal = live.ordinal;
	}
	if (insertSummary(live, children)) rerender();
}

/**
 * pi and cc both append process components straight to the chat container; wrapping addChild folds them
 * in the same call that attaches them, so nothing of the run is ever painted.
 */
function attachChat(chat: Container): void {
	state.chat = chat;
	// SAFETY: chat is a pi-tui Container; its instance hooks are only read and rewritten member by member.
	const holder = chat as unknown as { addChild?: AddChildHook; render?: PaintHook };
	const addChild = holder.addChild;
	if (typeof addChild === "function" && !addChild[HOOK_ADD_CHILD]) {
		const wrapped: AddChildHook = function (this: Container, child) {
			const component = child as FoldableComponent | undefined;
			const live = state.live;
			if (live && component) {
				if (component instanceof UserMessageComponent && live.userIndex < 0) {
					addChild.call(this, child);
					const children = this.children as FoldableComponent[];
					const index = children.indexOf(component);
					if (index >= 0) {
						live.userIndex = index;
						live.ordinal = children.slice(0, index + 1).filter((item) => item instanceof UserMessageComponent).length - 1;
						live.record.ordinal = live.ordinal;
						if (insertSummary(live, children)) rerender();
					}
					return;
				}
				if (isProcess(component, live)) {
					if (live.expanded) railComponent(component);
					else hideComponent(component);
					live.hidden.add(component);
					debug("add-child-hidden", () => ({ name: nameOf(component), rows: rowsOf(component) }));
				}
			}
			addChild.call(this, child);
		};
		wrapped[HOOK_ADD_CHILD] = true;
		holder.addChild = wrapped;
	}
	const render = holder.render;
	if (typeof render === "function" && !render[HOOK_PAINT]) {
		const wrapped: PaintHook = function (this: Container, width) {
			// last line of defence: a component that slipped past addChild is folded before it is painted
			if (state.live) {
				try {
					sweep(state.live);
				} catch (error) {
					warn("could not fold before paint", error);
				}
			}
			return render.call(this, width);
		};
		wrapped[HOOK_PAINT] = true;
		holder.render = wrapped;
	}
}

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
		if (this?.chatContainer) attachChat(this.chatContainer);
		const before = this?.chatContainer?.children.length;
		original.call(this, message, options);
		const children = this?.chatContainer?.children;
		debug("add-message", () => ({
			role: (message as { role?: string } | undefined)?.role,
			before,
			after: children?.length,
			added: before === undefined || !children ? undefined : nameOf(children[children.length - 1] as FoldableComponent),
		}));
		if (state.live) {
			try {
				sweep(state.live);
			} catch (error) {
				warn("could not hide the running turn", error);
			}
		}
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
 * Repaint in the same tick: pi builds its frame from process.nextTick, so a request made now lands in
 * that frame (a setTimeout(0) lands after it and leaves one frame showing the unfolded turn).
 */
function rerender(): void {
	const paint = (): void => {
		try {
			state.chat?.invalidate?.();
			state.ui?.requestRender?.(true);
		} catch (error) {
			warn("could not repaint", error);
		}
	};
	debug("rerender");
	paint();
	// one fallback for the window where pi is already composing and drops the first request
	queueMicrotask(paint);
}

/** Start the live row: everything the run adds to the chat goes behind it until it settles. */
function beginLive(pi: ExtensionAPI): void {
	releaseLive(state.live);
	const record: FoldRecord = { ordinal: 0, outcome: "running", tools: [], expanded: false };
	const live: Live = {
		ordinal: 0,
		userIndex: -1,
		startedAt: Date.now(),
		outcome: "running",
		calls: new Map(),
		hidden: new Set(),
		record,
		inserted: false,
		expanded: false,
	// SAFETY: the row needs the live record it belongs to; it is attached one statement below, before any render.
	summary: undefined as unknown as SummaryLine,
	};
	live.summary = new SummaryLine(
		{
			expanded: false,
			ms: 0,
			tools: [],
			outcome: "running",
			fg: fg(),
			refresh: () => ({
				ms: live.outcome === "running" ? Date.now() - live.startedAt : live.record.ms,
				tools: [...live.calls.values()],
				outcome: live.outcome,
			}),
		},
		(expanded) => {
			live.expanded = expanded;
			live.record.expanded = expanded;
			applyHidden(live.hidden, expanded);
			// the answer stays out of the rail either way
			if (live.reply) {
				showComponent(live.reply);
				unrailComponent(live.reply);
			}
			persist(pi, live.record);
			rerender();
		},
	);
	state.live = live;
	live.timer = setInterval(() => {
		if (state.live !== live) return;
		// rows pi and cc append on their own (streaming text, notices) never pass the message hook
		sweep(live);
		live.summary.invalidate();
		rerender();
	}, 500);
	live.timer.unref?.();
	attachSummary(live);
}

/** The chat children, with this run's user message located on first use. */
function resolveLive(live: Live): FoldableComponent[] | undefined {
	const children = state.chat?.children as FoldableComponent[] | undefined;
	if (!Array.isArray(children)) return undefined;
	if (live.userIndex < 0) {
		const index = lastUserIndex(children, UserMessageComponent);
		if (index < 0) return undefined;
		live.userIndex = index;
		live.ordinal = children.slice(0, index + 1).filter((component) => component instanceof UserMessageComponent).length - 1;
		live.record.ordinal = live.ordinal;
	}
	return children;
}

/** Process, not answer: tool rows, cc's tool groups, and every message the run streams before it settles. */
function isProcess(component: FoldableComponent, live: Live): boolean {
	if (component === live.reply) return false;
	if (component instanceof ToolExecutionComponent) return true;
	if (typeof (component as { toolName?: unknown }).toolName === "string") return true;
	// thinking and tool-calling text arrive in the same component the answer does: hidden until settle
	if (component instanceof AssistantMessageComponent) return true;
	// sub-agent notices and other custom rows: part of the run once it is doing tools
	return live.calls.size > 0;
}

/** Hide everything this run added after its user message; insert the row the first time. */
function sweep(live: Live): void {
	const children = resolveLive(live);
	if (!children) return;
	for (let index = live.userIndex + 1; index < children.length; index++) {
		const component = children[index];
		if (!component || component === live.summary || component instanceof Spacer) continue;
		if (component instanceof UserMessageComponent) break;
		if (isProcess(component, live)) live.hidden.add(component);
	}
	insertSummary(live, children);
	if (live.hidden.size > 0) applyHidden(live.hidden, live.expanded);
	debug("sweep", () => ({
		children: children.length,
		hidden: live.hidden.size,
		inserted: live.inserted,
		visible: children.filter((component) => rowsOf(component) > 0).map((component) => nameOf(component)),
	}));
}

/** Undo a live row completely: the process comes back, the row goes away. */
function releaseLive(live: Live | undefined): void {
	if (!live) return;
	if (live.timer) clearInterval(live.timer);
	applyHidden(live.hidden, true);
	if (live.reply) {
		showComponent(live.reply);
		unrailComponent(live.reply);
	}
	const children = state.chat?.children as FoldableComponent[] | undefined;
	if (Array.isArray(children) && live.inserted) {
		const index = children.indexOf(live.summary);
		if (index > 0) children.splice(index - 1, 3);
	}
	if (state.live === live) state.live = undefined;
}

/** Settle the live row: `working` becomes `took`, the answer comes out, the record is persisted. */
function finishLive(pi: ExtensionAPI, live: Live, ms: number, outcome: string): void {
	if (live.timer) clearInterval(live.timer);
	live.outcome = outcome;
	live.record.ms = ms;
	live.record.outcome = outcome;
	live.record.tools = [...live.calls.values()];
	live.summary.update({ ms, outcome });
	if (state.live === live) state.live = undefined;
	const children = resolveLive(live);
	const reply = children && [...children.slice(live.userIndex + 1)].reverse().find((component) => isFinalReply(component, AssistantMessageComponent));
	if (reply) {
		live.reply = reply;
		live.hidden.delete(reply);
	}
	if (live.record.tools.length === 0) {
		releaseLive(live);
		rerender();
		return;
	}
	sweep(live);
	if (reply) {
		showComponent(reply);
		unrailComponent(reply);
	}
	applyHidden(live.hidden, live.expanded);
	persist(pi, live.record);
	rerender();
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
	holder.fold = { summary: result.summary, record: result.record };
	state.folds.set(result.record.ordinal, holder.fold);
	persist(pi, result.record);
	return result;
}

function settle(pi: ExtensionAPI, aborted: boolean, outcome: string | undefined): void {
	const children = state.chat?.children as FoldableComponent[] | undefined;
	const live = state.live;
	let ms: number | undefined;
	if (live) ms = Date.now() - live.startedAt;
	else if (state.runStart !== undefined) ms = Date.now() - state.runStart;
	state.runStart = undefined;
	if (!Array.isArray(children)) return;
	const finalOutcome = aborted ? "aborted" : (outcome ?? "completed");
	if (!state.foldsEnabled) {
		releaseLive(live);
		rerender();
		return;
	}
	if (live) {
		finishLive(pi, live, ms ?? 0, finalOutcome);
		return;
	}
	foldAndTrack(pi, {
		children,
		userIndex: lastUserIndex(children, UserMessageComponent),
		ToolClass: ToolExecutionComponent,
		AssistantClass: AssistantMessageComponent,
		UserClass: UserMessageComponent,
		ms,
		outcome: finalOutcome,
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
	// a rebuilt transcript has no live row to keep in step
	releaseLive(state.live);
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
		if (!state.foldsEnabled) releaseLive(state.live);
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
		if (!state.live) beginLive(pi);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		rememberUi(ctx.ui as Ui);
		// agent_start may have opened the row already; a second one would drop what it hid
		if (state.foldsEnabled && !state.live) beginLive(pi);
	});

	pi.on("tool_execution_start", (event) => {
		const live = state.live;
		// nested calls belong to the tool that started them, not to the turn
		if (!live || event.parentToolCallId) return;
		live.calls.set(event.toolCallId, { name: event.toolName, failed: false });
		live.summary.invalidate();
		debug("tool-start", () => ({ tool: event.toolName, hidden: live.hidden.size, inserted: live.inserted }));
		sweep(live);
	});

	pi.on("tool_execution_end", (event) => {
		const live = state.live;
		const entry = live?.calls.get(event.toolCallId);
		if (!live || !entry) return;
		entry.failed = event.isError === true;
		entry.nested = nestedTools(event.result);
		entry.nestedFailed = nestedFailures(event.result) || undefined;
		live.summary.invalidate();
		sweep(live);
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

