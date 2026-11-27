import { appendFileSync } from "node:fs";
import { AssistantMessageComponent, InteractiveMode, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";
import type { Container } from "@earendil-works/pi-tui";
import {
	applyHidden,
	foldInterval,
	hideComponent,
	isHidden,
	isThinkingBlock,
	lastUserIndex,
	nestedFailures,
	nestedTools,
	pickVisibleTexts,
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

/** The function a wrapper wrapped, so re-installing unwraps instead of stacking. */
const HOOK_INNER = Symbol.for("pi-turn-fold.hook-inner");
/** The module instance that installed a wrapper; a /reload is a new one. */
const HOOK_OWNER = Symbol.for("pi-turn-fold.hook-owner");
const STATE_KEY = Symbol.for("pi-turn-fold.state");
const TURN_ENTRY = "pi-turn-fold.turn";
const OPTIONS_ENTRY = "pi-turn-fold.options";

interface Ui {
	theme?: { fg?: (color: string, text: string) => string };
	requestRender?(force?: boolean): void;
}

interface Fold {
	summary: SummaryLine;
	record: FoldRecord;
	/** Components the turn picked up after it settled (cc's tool group), hidden with the fold and shown with it. */
	extra: Set<FoldableComponent>;
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
	replies: FoldableComponent[];
	/** Settled: the row still stands, and the turn revives it if it goes on. */
	closed: boolean;
	timer?: ReturnType<typeof setInterval>;
}

interface FoldState {
	chat?: Container;
	ui?: Ui;
	pi?: ExtensionAPI;
	runStart?: number;
	outcome?: string;
	foldsEnabled: boolean;
	folds: Map<number, Fold>;
	live?: Live;
}

/** This module instance's token: its hooks are the ones that belong to this copy of the extension. */
const owner = {};

/**
 * One state per process, not per module instance. /reload loads a second copy of this file; every hook
 * (the first copy's included) has to read the same live row, fold records and chat container.
 */
const state: FoldState = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= { foldsEnabled: true, folds: new Map() }) as FoldState;

/**
 * The component classes every turn decision tests against. pi exports them; the tests swap in fakes,
 * so both sides read one table instead of naming a class in a dozen places.
 */
// SAFETY: each value is the real component class; the cast only widens the constructor signature so the
// table can also hold the fakes tests assign, which share the render/invalidate surface the hook uses.
const classes = {
	User: UserMessageComponent as unknown as new (...args: never[]) => unknown,
	Assistant: AssistantMessageComponent as unknown as new (...args: never[]) => unknown,
	Tool: ToolExecutionComponent as unknown as new (...args: never[]) => unknown,
};

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

type AddMessageToChat = (this: ChatHost, message: unknown, options?: unknown) => void;

type RenderSessionItems = (this: ChatHost, items: unknown, meta?: unknown, options?: unknown) => void;

type AddChildHook = (this: Container, child: unknown) => void;

type PaintHook = (this: Container, width: number) => readonly string[];

/** A wrapped method, remembering what it wrapped and which module instance installed it. */
type Hooked<F> = F & { [HOOK_INNER]?: F; [HOOK_OWNER]?: unknown };

/**
 * The live row is spliced right under this turn's user message, before any process row exists, so the
 * first frame already reads as one folded turn.
 */
function insertSummary(live: Live, children: FoldableComponent[]): boolean {
	if (live.inserted || live.userIndex < 0) return false;
	children.splice(live.userIndex + 1, 0, new Spacer(1), live.summary, new Spacer(1));
	live.inserted = true;
	state.folds.set(live.record.ordinal, { summary: live.summary, record: live.record, extra: new Set() });
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
		if (!(last instanceof classes.User)) return;
		live.userIndex = children.length - 1;
		live.ordinal = children.filter((component) => component instanceof classes.User).length - 1;
		live.record.ordinal = live.ordinal;
	}
	if (insertSummary(live, children)) rerender();
}

/** A user message arriving while a row is live: the first one places the row, a later one starts the next turn. */
function placeUserMessage(live: Live, component: FoldableComponent, children: FoldableComponent[], append: () => void): void {
	const first = live.userIndex < 0;
	// a newer user message opens the next turn: this row stays a fold
	if (!first) detachLive(live);
	append();
	if (!first) return;
	const index = children.indexOf(component);
	if (index < 0) return;
	live.userIndex = index;
	live.ordinal = children.slice(0, index + 1).filter((item) => item instanceof classes.User).length - 1;
	live.record.ordinal = live.ordinal;
	if (insertSummary(live, children)) rerender();
}

/**
 * Wrap a method on `holder` with a wrapper owned by this module instance — always. /reload loads a
 * second copy of this file, and the wrapper the first copy left closes over the first copy's closures;
 * it has to be replaced. Our own earlier wrapper is unwrapped first, so installs never stack.
 */
function rewrap<F extends (...args: never[]) => unknown>(holder: Record<string, unknown>, name: string, make: (inner: F) => F): boolean {
	const current = holder[name] as Hooked<F> | undefined;
	if (typeof current !== "function") return false;
	if (current[HOOK_OWNER] === owner) return true;
	// only a wrapper of ours is unwrapped: another extension's layer stays where it is
	const previous = (current[HOOK_OWNER] === undefined ? current : current[HOOK_INNER]) as F | undefined;
	const inner = typeof previous === "function" ? previous : current;
	const wrapped = make(inner) as Hooked<F>;
	wrapped[HOOK_INNER] = inner;
	wrapped[HOOK_OWNER] = owner;
	holder[name] = wrapped;
	return true;
}

/**
 * A folded turn gets new components after it settled: cc regroups the restored tools once /reload mounts
 * them, and a group is a component no fold ever saw. Every paint, hide what landed inside a collapsed
 * fold; components already hidden are skipped, so the scan is all this costs per frame.
 */
function resweepFolds(): void {
	const children = state.chat?.children as FoldableComponent[] | undefined;
	if (!Array.isArray(children) || state.folds.size === 0) return;
	const live = state.live?.summary;
	for (const fold of state.folds.values()) {
		if (fold.summary === live || fold.summary.expanded) continue;
		const start = children.indexOf(fold.summary);
		if (start < 0) continue;
		const end = children.findIndex((component, index) => index > start && component instanceof classes.User);
		const interval = children.slice(start + 1, end < 0 ? children.length : end);
		const replies = pickVisibleTexts(interval, classes.Assistant);
		const stale = interval.filter((component) => !(component instanceof Spacer) && !replies.includes(component) && !isHidden(component));
		if (stale.length === 0) continue;
		debug("resweep", () => ({ ordinal: fold.record.ordinal, names: stale.map(nameOf) }));
		for (const component of stale) fold.extra.add(component);
		applyHidden(stale, false);
	}
}

/**
 * pi and cc both append process components straight to the chat container; wrapping addChild folds them
 * in the same call that attaches them, so nothing of the run is ever painted.
 */
function attachChat(chat: Container): void {
	state.chat = chat;
	// SAFETY: chat is a pi-tui Container; its instance hooks are only read and rewritten member by member.
	const holder = chat as unknown as Record<string, unknown>;
	rewrap<AddChildHook>(holder, "addChild", (addChild) =>
		function (this: Container, child) {
			const component = child as FoldableComponent | undefined;
			const live = state.live;
			if (live && component) {
				if (component instanceof classes.User) {
					placeUserMessage(live, component, this.children as FoldableComponent[], () => addChild.call(this, child));
					return;
				}
				const current = rowFor(component);
				if (current && isProcess(component, current)) {
					if (current.expanded) railComponent(component);
					else hideComponent(component);
					current.hidden.add(component);
					debug("add-child-hidden", () => ({ name: nameOf(component), rows: rowsOf(component) }));
				}
			}
			addChild.call(this, child);
		},
	);
	rewrap<PaintHook>(holder, "render", (render) =>
		function (this: Container, width) {
			// last line of defence: a component that slipped past addChild is folded before it is painted
			if (state.live && !state.live.closed) {
				try {
					sweep(state.live);
				} catch (error) {
					warn("could not fold before paint", error);
				}
			}
			try {
				resweepFolds();
			} catch (error) {
				warn("could not fold the restored turns before paint", error);
			}
			return render.call(this, width);
		},
	);
}

/**
 * cc keeps thinking text in its own collapsible box inside the answer component. Hide it there:
 * hooking the box container drops it now and again whenever cc rebuilds the message.
 */
function hideThinking(component: FoldableComponent): void {
	const container = (component as { contentContainer?: Container }).contentContainer;
	if (!container) return;
	// SAFETY: a chat component is a Container whose children array and addChild method are the only members read.
	const holder = container as unknown as Record<string, unknown>;
	rewrap<AddChildHook>(holder, "addChild", (addChild) =>
		function (this: Container, child) {
			if (!isThinkingBlock(child as FoldableComponent)) addChild.call(this, child);
		},
	);
	const children = holder.children as unknown[] | undefined;
	if (Array.isArray(children)) {
		const kept = children.filter((child) => !isThinkingBlock(child as FoldableComponent));
		if (kept.length !== children.length) children.splice(0, children.length, ...kept);
	}
}

function installChatHook(): boolean {
	// SAFETY: the class is a real constructor; only its prototype surface is read, member by member.
	const proto = (InteractiveMode as unknown as { prototype?: Record<string, unknown> })?.prototype;
	if (!proto) return false;
	const installed = rewrap<AddMessageToChat>(proto, "addMessageToChat", (original) =>
		function (this: ChatHost, message, options) {
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
			const live = state.live;
			if (live && !live.closed) {
				try {
					sweep(live);
				} catch (error) {
					warn("could not hide the running turn", error);
				}
			}
		},
	);
	if (!installed) {
		warn("InteractiveMode.addMessageToChat not found; turn folding disabled");
		return false;
	}
	return true;
}

/**
 * A resumed session renders the transcript through InteractiveMode.renderSessionItems, so the
 * folds are re-applied right after that render — the one point where every message is attached.
 */
function installRenderHook(pi: ExtensionAPI): boolean {
	// SAFETY: the class is a real constructor; only its prototype surface is read, member by member.
	const proto = (InteractiveMode as unknown as { prototype?: Record<string, unknown> })?.prototype;
	if (!proto) return false;
	const installed = rewrap<RenderSessionItems>(proto, "renderSessionItems", (original) =>
		function (this: ChatHost, items, meta, options) {
			original.call(this, items, meta, options);
			try {
				restore(pi, this.sessionManager?.getBranch?.());
			} catch (error) {
				warn("restore failed", error);
			}
		},
	);
	if (!installed) warn("InteractiveMode.renderSessionItems not found; saved folds cannot be restored");
	return installed;
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

/** One 500ms tick per live row: pi and cc append rows that never pass the message hook. */
function startTimer(live: Live): void {
	if (live.timer) return;
	live.timer = setInterval(() => {
		if (state.live !== live || live.closed) return;
		sweep(live);
		live.summary.invalidate();
		rerender();
	}, 500);
	live.timer.unref?.();
}

/** Start the live row: everything the run adds to the chat goes behind it until it settles. */
function beginLive(pi: ExtensionAPI): void {
	// a finished turn stays a fold; only one that never settled is closed here
	detachLive(state.live);
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
		replies: [],
		closed: false,
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
			for (const reply of live.replies) {
				showComponent(reply);
				unrailComponent(reply);
			}
			persist(pi, live.record);
			rerender();
		},
	);
	state.live = live;
	startTimer(live);
	attachSummary(live);
}

/** True when the chat already holds a user message newer than this row's turn: the row is history. */
function turnAdvanced(live: Live): boolean {
	const children = state.chat?.children as FoldableComponent[] | undefined;
	if (!Array.isArray(children) || live.userIndex < 0) return false;
	return lastUserIndex(children, classes.User) > live.userIndex;
}

/** The turn went on after settling: same row, its own clock, `working` again. */
function revive(live: Live): void {
	if (!live.closed) return;
	live.closed = false;
	live.outcome = "running";
	live.record.outcome = "running";
	live.startedAt = Date.now();
	live.summary.update({ outcome: "running" });
	startTimer(live);
	debug("revived", () => ({ ordinal: live.ordinal, calls: live.calls.size, hidden: live.hidden.size }));
	rerender();
}

/** The row of the turn that is going on right now: a settled one revives, a superseded one steps aside. */
function liveForCurrentTurn(): Live | undefined {
	const live = state.live;
	if (!live) return undefined;
	if (turnAdvanced(live)) {
		detachLive(live);
		return undefined;
	}
	if (live.closed) revive(live);
	return live;
}

/** A tool row, bare or grouped: the only arrival that means the turn is doing work again after a settle. */
function isToolComponent(component: FoldableComponent): boolean {
	return component instanceof classes.Tool || typeof (component as { toolName?: unknown }).toolName === "string";
}

/**
 * The row a freshly arrived component belongs to. A settled row revives for work, not for text: what the
 * run says after it settled is an answer, and answers stay outside the fold.
 */
function rowFor(component: FoldableComponent): Live | undefined {
	const live = state.live;
	if (!live) return undefined;
	if (turnAdvanced(live)) {
		detachLive(live);
		return undefined;
	}
	if (!live.closed) return live;
	if (!isToolComponent(component)) return undefined;
	revive(live);
	return live;
}

/** Stop tracking a row: what it folded stays folded, a run that never settled is closed first. */
function detachLive(live: Live | undefined): void {
	if (!live) return;
	if (!live.closed && state.pi) finishLive(state.pi, live, Date.now() - live.startedAt, state.outcome ?? "completed");
	if (live.timer) {
		clearInterval(live.timer);
		live.timer = undefined;
	}
	if (state.live === live) state.live = undefined;
}

/** The chat children, with this run's user message located on first use. */
function resolveLive(live: Live): FoldableComponent[] | undefined {
	const children = state.chat?.children as FoldableComponent[] | undefined;
	if (!Array.isArray(children)) return undefined;
	if (live.userIndex < 0) {
		const index = lastUserIndex(children, classes.User);
		if (index < 0) return undefined;
		live.userIndex = index;
		live.ordinal = children.slice(0, index + 1).filter((component) => component instanceof classes.User).length - 1;
		live.record.ordinal = live.ordinal;
	}
	return children;
}

/** Process, not answer: tool rows, cc's tool groups, and every message the run streams before it settles. */
function isProcess(component: FoldableComponent, live: Live): boolean {
	if (live.replies.includes(component)) return false;
	if (component instanceof classes.Tool) return true;
	if (typeof (component as { toolName?: unknown }).toolName === "string") return true;
	// thinking and tool-calling text arrive in the same component the answer does: hidden until settle
	if (component instanceof classes.Assistant) return true;
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
		if (component instanceof classes.User) break;
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
	if (live.timer) {
		clearInterval(live.timer);
		live.timer = undefined;
	}
	applyHidden(live.hidden, true);
	for (const reply of live.replies) {
		showComponent(reply);
		unrailComponent(reply);
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
	if (live.timer) {
		clearInterval(live.timer);
		live.timer = undefined;
	}
	live.outcome = outcome;
	live.record.ms = ms;
	live.record.outcome = outcome;
	live.record.tools = [...live.calls.values()];
	live.summary.update({ ms, outcome });
	// the row stays: pi settles a turn that may go on, and then this row revives instead of a second one
	live.closed = true;
	const children = resolveLive(live);
	// the run stops at the next user message, like sweep
	const end = children?.findIndex((component, index) => index > live.userIndex && component instanceof classes.User) ?? -1;
	const segment = children?.slice(live.userIndex + 1, end < 0 ? children.length : end) ?? [];
	// every substantive text of the turn, not only the run after the last tool row: a continuation
	// (a gate's nudge, a queued reply) streams several messages in one turn, and a report sent before
	// a verifying call is an answer as much as the closing message is
	live.replies = pickVisibleTexts(segment, classes.Assistant);
	if (live.record.tools.length === 0) {
		for (const reply of live.replies) hideThinking(reply);
		releaseLive(live);
		rerender();
		return;
	}
	sweep(live);
	for (const reply of live.replies) live.hidden.delete(reply);
	applyHidden(live.hidden, live.expanded);
	// released after applyHidden, so nothing folds them back
	for (const reply of live.replies) {
		showComponent(reply);
		unrailComponent(reply);
		hideThinking(reply);
	}
	const answerRows = segment.filter((component) => component instanceof classes.Assistant).reduce((rows, component) => rows + rowsOf(component), 0);
	debug("settle", () => ({ userIndex: live.userIndex, end, replies: live.replies.length, answerRows, hidden: live.hidden.size }));
	persist(pi, live.record);
	rerender();
	if (answerRows === 0) {
		// never eat the answer: with nothing of it visible, the whole turn comes back
		debug("answer-lost", () => ({ userIndex: live.userIndex, unfolded: live.hidden.size }));
		live.summary.setExpanded(true);
	}
}

/** Record a top-level tool call on the turn's row, and fold what it already brought in. */
function noteToolStart(pi: ExtensionAPI, event: { toolCallId: string; toolName: string; parentToolCallId?: string }): void {
	// nested calls belong to the tool that started them, not to the turn
	if (event.parentToolCallId) return;
	let live = liveForCurrentTurn();
	// the run went on without a row of its own: open one rather than paint the rest of the turn raw
	if (!live && state.foldsEnabled) {
		beginLive(pi);
		live = state.live;
	}
	if (!live) return;
	const row = live;
	row.calls.set(event.toolCallId, { name: event.toolName, failed: false });
	row.summary.invalidate();
	debug("tool-start", () => ({ tool: event.toolName, hidden: row.hidden.size, inserted: row.inserted }));
	sweep(row);
}

function noteToolEnd(event: { toolCallId: string; isError?: boolean; result?: unknown }): void {
	const live = state.live;
	const entry = live?.calls.get(event.toolCallId);
	if (!live || !entry) return;
	entry.failed = event.isError === true;
	entry.nested = nestedTools(event.result);
	entry.nestedFailed = nestedFailures(event.result) || undefined;
	live.summary.invalidate();
	sweep(live);
}

/** Fold one turn and remember it, so `/fold turn N` and a reopened session can find it. */
function foldAndTrack(pi: ExtensionAPI, input: Parameters<typeof foldInterval>[0]): FoldResult | undefined {
	const holder: { fold?: Fold } = {};
	const result = foldInterval({
		...input,
		onToggle: (expanded) => {
			if (holder.fold) {
				holder.fold.record.expanded = expanded;
				// what the turn picked up after it settled goes with it, in both directions
				applyHidden(holder.fold.extra, expanded);
				persist(pi, holder.fold.record);
			}
			rerender();
		},
	});
	if (!result) return undefined;
	holder.fold = { summary: result.summary, record: result.record, extra: new Set() };
	state.folds.set(result.record.ordinal, holder.fold);
	persist(pi, result.record);
	return result;
}

function settle(pi: ExtensionAPI, aborted: boolean, outcome: string | undefined): void {
	const children = state.chat?.children as FoldableComponent[] | undefined;
	const live = state.live;
	if (live?.closed) return;
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
		userIndex: lastUserIndex(children, classes.User),
		ToolClass: classes.Tool,
		AssistantClass: classes.Assistant,
		UserClass: classes.User,
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
	// a second pass over a transcript that already carries our rows would splice a second row per turn
	const folded = [...state.folds.values()];
	if (folded.length > 0 && folded.every((fold) => children.includes(fold.summary))) return;
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
		const userIndices = (children as FoldableComponent[]).flatMap((component, index) => (component instanceof classes.User ? [index] : []));
		const userIndex = userIndices[record.ordinal];
		if (userIndex === undefined) continue;
		foldAndTrack(pi, {
			children,
			userIndex,
			ToolClass: classes.Tool,
			AssistantClass: classes.Assistant,
			UserClass: classes.User,
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

interface FoldCommandContext {
	ui?: { notify?(message: string, type?: "info" | "warning" | "error"): void };
}

/**
 * `/fold doctor`: which module instance owns each hook and what the shared state sees. A /reload leaves
 * the previous copy's wrappers behind, and this is the one place that tells them apart.
 */
function doctor(ctx: FoldCommandContext | undefined): void {
	// SAFETY: the class is a real constructor; only its hook markers are read.
	const proto = ((InteractiveMode as unknown as { prototype?: Record<string, unknown> })?.prototype ?? {}) as Record<string, unknown>;
	const chat = state.chat as (Record<string, unknown> & { children?: unknown[] }) | undefined;
	const owners = ["addMessageToChat", "renderSessionItems", "addChild"].map((name) => {
		const holder = name === "addChild" ? (chat ?? {}) : proto;
		const method = holder[name] as Hooked<unknown> | undefined;
		const who = typeof method !== "function" ? "missing" : method[HOOK_OWNER] === owner ? "mine" : method[HOOK_OWNER] === undefined ? "foreign" : "stale";
		return `${name} ${who}`;
	});
	const live = state.live;
	const report = [
		`hooks: ${owners.join(", ")}`,
		`chat: ${chat ? `${chat.children?.length ?? 0} children` : "not attached"} · folds: ${state.folds.size} · folding: ${state.foldsEnabled ? "on" : "off"}`,
		`live: ${live ? `${live.closed ? "settled" : "running"} · ${live.calls.size} calls · ${live.hidden.size} hidden · ${live.inserted ? "row in" : "no row"}` : "none"}`,
	].join("\n");
	debug("doctor", () => ({ report }));
	if (!state.chat) {
		ctx?.ui?.notify?.(report, "info");
		return;
	}
	// a chat row stays on screen and can be copied, unlike a status line that fades
	state.chat.addChild(new Text(`${report}\n`, 1, 0));
	rerender();
}

function runCommand(pi: ExtensionAPI, args: string, ctx?: FoldCommandContext): void {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words[0] === "doctor") {
		doctor(ctx);
		return;
	}
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
	state.pi = pi;
	installRenderHook(pi);

	pi.registerCommand("fold", {
		description: "Fold turn transcripts: /fold turn [N|last], /fold on|off, /fold doctor",
		handler: async (args, ctx) => {
			try {
				runCommand(pi, args, ctx);
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

	pi.on("session_start", (_event, ctx) => {
		reload(ctx);
		// /reload rebuilds the transcript before the extension comes back; fold it from the branch again
		try {
			restore(pi, ctx.sessionManager?.getBranch?.());
		} catch (error) {
			warn("restore after start failed", error);
		}
	});

	pi.on("session_tree", (_event, ctx) => reload(ctx));

	pi.on("agent_start", () => {
		state.runStart = Date.now();
		state.outcome = undefined;
		// a continuation (retry, queued reply) revives the turn's row; a submitted prompt already opened one
		if (state.foldsEnabled && !liveForCurrentTurn()) beginLive(pi);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		rememberUi(ctx.ui as Ui);
		// pi fires this only for a submitted prompt, and before that prompt reaches the chat: a new turn,
		// whatever row is still live belongs to the previous one
		if (state.foldsEnabled) beginLive(pi);
	});

	pi.on("tool_execution_start", (event) => noteToolStart(pi, event));

	pi.on("tool_execution_end", (event) => noteToolEnd(event));

	pi.on("agent_before_settle", (event) => {
		state.outcome = event.outcome;
	});

	pi.on("agent_settled", (event, ctx) => {
		rememberUi(ctx.ui as Ui);
		const outcome = state.outcome;
		// the row this run settled; a settle that lands after the next turn opened must not touch it
		const settled = state.live;
		// let pi attach the last components before rewriting the container
		setTimeout(() => {
			try {
				const idle = ctx.isIdle();
				debug("settle-check", () => ({ idle }));
				// pi also settles between retries and continuations: a run that is already going on keeps its row
				if (!idle) return;
				if (state.live !== settled) {
					debug("settle-ignored-turn-moved");
					return;
				}
				settle(pi, event.aborted, outcome);
			} catch (error) {
				warn("fold failed", error);
			}
		}, 0);
	});
}

/** Test seam: the turn state machine, drivable with a fake pi, a fake container and fake components. */
export const __test = {
	state,
	classes,
	attachChat,
	installChatHook,
	installRenderHook,
	beginLive,
	settle,
	finishLive,
	releaseLive,
	revive,
	detachLive,
	liveForCurrentTurn,
};

