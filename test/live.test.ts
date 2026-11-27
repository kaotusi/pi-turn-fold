import assert from "node:assert/strict";
import test from "node:test";
import piTurnFold, { __test } from "../extensions/index.ts";
import { SummaryLine, type FoldableComponent } from "../extensions/fold.ts";

class TUser implements FoldableComponent {
	render(_width: number): string[] {
		return ["user"];
	}
	invalidate(): void {}
}

class TTool implements FoldableComponent {
	toolName: string;
	constructor(name: string) {
		this.toolName = name;
	}
	render(_width: number): string[] {
		return [`tool ${this.toolName}`];
	}
	invalidate(): void {}
}

class TAssistant implements FoldableComponent {
	lastMessage = { content: [{ type: "text", text: "done" }] };
	render(_width: number): string[] {
		return ["assistant"];
	}
	invalidate(): void {}
}

// SAFETY: the fakes implement exactly the surface the hook reads (render, invalidate, toolName/lastMessage);
// swapping them in is the point of the seam, and the tables accept any constructor.
__test.classes.User = TUser as unknown as typeof __test.classes.User;
__test.classes.Assistant = TAssistant as unknown as typeof __test.classes.Assistant;
__test.classes.Tool = TTool as unknown as typeof __test.classes.Tool;

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
	chat: { children: FoldableComponent[]; addChild(child: FoldableComponent): void; render(): string[] };
	fire(type: string): void;
	settle(aborted: boolean, idle: boolean): Promise<void>;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness(): Harness {
	const handlers = new Map<string, Handler>();
	piTurnFold({
		on(type: string, handler: Handler) {
			handlers.set(type, handler);
			return () => {};
		},
		registerCommand() {},
		appendEntry() {
			return "entry";
		},
	} as never);
	// SAFETY: the chat is a stand-in for pi-tui's Container; attachChat only wraps addChild/render on it.
	const chat = {
		children: [] as FoldableComponent[],
		addChild(child: FoldableComponent) {
			this.children.push(child);
		},
		render() {
			return [];
		},
	} as { children: FoldableComponent[]; addChild(child: FoldableComponent): void; render(): string[] };
	__test.attachChat(chat as never);
	const fire = (type: string): void => {
		handlers.get(type)?.({}, { ui: {}, isIdle: () => true });
	};
	return {
		chat,
		fire,
		// the settle handler defers one macrotask, so the assertion runs after it
		async settle(aborted: boolean, idle: boolean): Promise<void> {
			handlers.get("agent_settled")?.({ aborted }, { ui: {}, isIdle: () => idle });
			await tick();
		},
	};
}

/** A frozen clock: the settle path reads Date.now, and the test decides how much a segment lasted. */
function withClock(start: number): { advance(ms: number): void; restore(): void } {
	const original = Date.now;
	let now = start;
	Date.now = () => now;
	return {
		advance(ms: number) {
			now += ms;
		},
		restore() {
			Date.now = original;
		},
	};
}

function startTurn(h: Harness): void {
	h.fire("agent_start");
}

function user(h: Harness): void {
	h.chat.addChild(new TUser());
}

/** A tool call as pi reports it: the event first, then the component the chat receives. */
function tool(h: Harness, id: string, name: string): TTool {
	__test.state.live?.calls.set(id, { name, failed: false });
	h.fire("tool_execution_start");
	const component = new TTool(name);
	h.chat.addChild(component);
	return component;
}

const shown = (component: FoldableComponent): boolean => component.render(80).length > 0;
const rowsOf = (h: Harness): number => h.chat.children.filter((child) => child instanceof SummaryLine).length;
const summaryAt = (h: Harness): SummaryLine => h.chat.children.filter((child): child is SummaryLine => child instanceof SummaryLine).at(-1)!;

function reset(): void {
	// SAFETY: the state machine is a module singleton; the seam exposes it so each test starts clean.
	const state = __test.state;
	if (state.live) __test.releaseLive(state.live);
	state.chat = undefined;
	state.live = undefined;
	state.runStart = undefined;
	state.outcome = undefined;
	state.foldsEnabled = true;
	state.folds.clear();
}

test("a settle that arrives while the run is still going leaves the turn folded", async () => {
	reset();
	const h = harness();
	user(h);
	startTurn(h);
	const first = tool(h, "a1", "bash");
	h.fire("agent_before_settle");
	__test.state.outcome = "aborted";
	await h.settle(true, false);
	assert.equal(__test.state.live?.closed, false, "not idle: the turn is still live, not settled");
	assert.equal(shown(first), false, "the running turn stays folded");

	const second = tool(h, "a2", "read");
	assert.equal(shown(second), false, "the tool that follows the ignored settle is folded too");
	assert.equal(rowsOf(h), 1, "still one row for the turn");
});

test("a tool after a real settle revives the same row instead of opening a second one", async () => {
	reset();
	const h = harness();
	user(h);
	startTurn(h);
	const first = tool(h, "a1", "bash");
	h.chat.addChild(new TAssistant());
	await h.settle(false, true);
	const row = __test.state.live;
	assert.ok(row?.closed, "settled: the row is closed but kept");
	assert.equal(rowsOf(h), 1);
	const summary = summaryAt(h);

	const second = tool(h, "a2", "read");
	assert.equal(__test.state.live, row, "the same live row is reused");
	assert.equal(__test.state.live?.closed, false, "revived");
	assert.equal(summaryAt(h), summary, "no second row grew");
	assert.equal(rowsOf(h), 1);
	assert.equal(shown(second), false, "the new call is folded behind the revived row");
	assert.equal(shown(first), false, "the folded calls stay folded");
	assert.match(summary.render(80)[0], /working/, "back to a running row");
});

test("a revived row times the new segment, never the settled one", async () => {
	reset();
	const clock = withClock(1_000_000);
	try {
		const h = harness();
		user(h);
		startTurn(h);
		tool(h, "a1", "bash");
		h.chat.addChild(new TAssistant());
		clock.advance(30_000);
		await h.settle(false, true);
		assert.equal(__test.state.live?.record.ms, 30_000, "the settled record holds the first segment");

		clock.advance(45_000);
		tool(h, "a2", "read");
		clock.advance(5_000);
		await h.settle(false, true);
		assert.equal(__test.state.live?.record.ms, 5_000, "the second settle times only its own segment");
	} finally {
		clock.restore();
	}
});

test("a real next turn keeps the old row and opens its own", async () => {
	reset();
	const h = harness();
	user(h);
	startTurn(h);
	tool(h, "a1", "bash");
	h.chat.addChild(new TAssistant());
	await h.settle(false, true);
	const firstRow = __test.state.live;

	user(h);
	startTurn(h);
	const second = tool(h, "b1", "read");
	assert.notEqual(__test.state.live, firstRow, "a new turn is a new live row");
	assert.equal(rowsOf(h), 2, "one row per turn, none left over");
	assert.equal(shown(second), false, "the new turn is folded");
	assert.equal(firstRow?.closed, true, "the previous turn stays settled");
});

test("a live carried over from an earlier turn is not reused for the next one", () => {
	reset();
	const h = harness();
	user(h);
	startTurn(h);
	tool(h, "a1", "bash");
	const stale = __test.state.live;
	// the user types while the turn is still running: pi queues it and starts a run right after
	user(h);
	startTurn(h);
	const fresh = tool(h, "b1", "read");
	assert.notEqual(__test.state.live, stale, "the stale turn does not own the new run");
	assert.equal(stale?.closed, true);
	assert.equal(rowsOf(h), 2);
	assert.equal(shown(fresh), false);
	const users = h.chat.children.filter((child) => child instanceof TUser);
	assert.equal(users.length, 2, "the next turn's user message is still attached");
	assert.equal(shown(users[1]), true, "the new user message is not folded away");
});

test("text that arrives after the settle does not reopen the row", async () => {
	reset();
	const h = harness();
	user(h);
	startTurn(h);
	tool(h, "a1", "bash");
	h.chat.addChild(new TAssistant());
	const clock0 = __test.state.live?.startedAt;
	await h.settle(false, true);
	const settled = __test.state.live;
	assert.equal(settled?.closed, true);
	const settledMs = settled?.record.ms;

	h.chat.addChild(new TAssistant());
	assert.equal(__test.state.live?.closed, true, "a message is an answer, not work");
	assert.equal(rowsOf(h), 1);
	assert.equal(__test.state.live?.record.ms, settledMs, "the settled record is not rewritten");
	assert.equal(__test.state.live?.startedAt, clock0, "the clock does not restart for text");
});

test("a submitted prompt opens the next row before its user message lands", async () => {
	reset();
	const h = harness();
	user(h);
	startTurn(h);
	tool(h, "a1", "bash");
	h.chat.addChild(new TAssistant());
	await h.settle(false, true);
	const firstRow = __test.state.live;
	const firstMs = firstRow?.record.ms;

	// pi announces the submitted prompt before the chat shows it
	h.fire("before_agent_start");
	assert.notEqual(__test.state.live, firstRow, "the settled row is not revived for the next turn");
	assert.equal(firstRow?.closed, true);
	assert.equal(firstRow?.record.ms, firstMs, "the settled record keeps its own clock");

	user(h);
	startTurn(h);
	const second = tool(h, "b1", "read");
	assert.equal(rowsOf(h), 2, "one row per turn");
	assert.equal(shown(second), false);
});
