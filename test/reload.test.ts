import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import foldFirst, { __test } from "../extensions/index.ts";
import { SummaryLine, type FoldableComponent } from "../extensions/fold.ts";

/**
 * A /reload evaluates this extension again. The query is what makes node hand back a second copy, so the
 * two module instances here are exactly the two a reload leaves behind.
 */
const SECOND_COPY = "../extensions/index.ts?reload=1";
type Module = typeof import("../extensions/index.ts");
const second = (await import(SECOND_COPY)) as Module;
const foldAgain = second.default;

/** A wrapper of ours wraps once: its inner is the original function, never another wrapper. */
const HOOK_INNER = Symbol.for("pi-turn-fold.hook-inner");
function depth(fn: unknown): number {
	let count = 0;
	let current = fn as (Record<symbol, unknown> & ((...args: never[]) => unknown)) | undefined;
	while (typeof current === "function") {
		current = current[HOOK_INNER] as typeof current;
		count++;
	}
	return count;
}

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

function fakeClasses(seam: typeof __test): void {
	// SAFETY: the fakes implement exactly the surface the hooks read (render, invalidate, toolName/lastMessage);
	// swapping them in is the point of the seam, and the table accepts any constructor.
	seam.classes.User = TUser as unknown as typeof seam.classes.User;
	seam.classes.Assistant = TAssistant as unknown as typeof seam.classes.Assistant;
	seam.classes.Tool = TTool as unknown as typeof seam.classes.Tool;
}
fakeClasses(__test);
fakeClasses(second.__test);

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Chat {
	children: FoldableComponent[];
	addChild(child: FoldableComponent): void;
	render(): string[];
	invalidate(): void;
}

function makeChat(children: FoldableComponent[] = []): Chat {
	return {
		children,
		addChild(child: FoldableComponent) {
			this.children.push(child);
		},
		render() {
			return [];
		},
		invalidate() {},
	};
}

interface Session {
	seam: typeof __test;
	chat: Chat;
	fire(type: string, event?: unknown, ctx?: unknown): void;
}

const idle = { ui: {}, isIdle: () => true };

/** Load the extension the way pi does: the factory runs, then the chat container is attached. */
function load(factory: (pi: never) => void, seam: typeof __test, chat: Chat): Session {
	const handlers = new Map<string, Handler>();
	factory({
		on(type: string, handler: Handler) {
			handlers.set(type, handler);
			return () => {};
		},
		registerCommand() {},
		appendEntry() {
			return "entry";
		},
	} as never);
	seam.attachChat(chat as never);
	return {
		seam,
		chat,
		fire(type, event = {}, ctx = idle) {
			handlers.get(type)?.(event, ctx);
		},
	};
}

/** A tool call as pi reports it: the event first, then the component the chat receives. */
function call(session: Session, id: string, name: string): TTool {
	session.fire("tool_execution_start", { toolCallId: id, toolName: name });
	const component = new TTool(name);
	session.chat.addChild(component);
	return component;
}

const shown = (component: FoldableComponent): boolean => component.render(80).length > 0;
const rowsOf = (chat: Chat): number => chat.children.filter((child) => child instanceof SummaryLine).length;

function reset(): void {
	// SAFETY: the state lives on globalThis, so every copy of the module reads the same one; the seam exposes it.
	const state = __test.state;
	if (state.live) __test.releaseLive(state.live);
	state.chat = undefined;
	state.live = undefined;
	state.runStart = undefined;
	state.outcome = undefined;
	state.foldsEnabled = true;
	state.folds.clear();
}

test("a reloaded copy of the extension folds with the state the first copy wrote", () => {
	reset();
	const chat = makeChat();
	const first = load(foldFirst, __test, chat);
	assert.equal(second.__test.state, __test.state, "one state per process, not one state per module instance");

	chat.addChild(new TUser());
	first.fire("agent_start");
	const earlier = call(first, "a1", "bash");
	assert.equal(shown(earlier), false);
	assert.equal(rowsOf(chat), 1);

	// pi rebuilds the transcript and evaluates the extension again
	chat.children.length = 0;
	const again = load(foldAgain, second.__test, chat);
	chat.addChild(new TUser());
	again.fire("agent_start");
	const later = call(again, "b1", "read");
	assert.equal(shown(later), false, "the new copy folds the running turn");
	assert.equal(rowsOf(chat), 1, "and the previous copy's row is not doubled");
});

test("loading the extension again unwraps the stale hooks instead of stacking them", () => {
	reset();
	const chat = makeChat();
	load(foldFirst, __test, chat);
	load(foldAgain, second.__test, chat);
	// SAFETY: the class is a real constructor; only its prototype surface is read.
	const proto = ((InteractiveMode as unknown as { prototype?: Record<string, unknown> }).prototype ?? {}) as Record<string, unknown>;
	assert.equal(depth(proto.addMessageToChat), 2, "one wrapper over the original method");
	assert.equal(depth(proto.renderSessionItems), 2, "one wrapper over the original method");
	assert.equal(depth(chat.addChild), 2, "one wrapper over the chat's addChild");
});

test("a component mounted into a folded turn after the restore is folded on the next paint", () => {
	reset();
	const answer = new TAssistant();
	const tool = new TTool("bash");
	const chat = makeChat([new TUser(), tool, answer]);
	const branch = [
		{ type: "custom", customType: "pi-turn-fold.turn", data: { ordinal: 0, ms: 1_000, outcome: "completed", expanded: false, tools: [{ name: "bash", failed: false }] } },
	];
	load(foldFirst, __test, chat).fire("session_start", {}, { ui: {}, sessionManager: { getBranch: () => branch } });

	// cc regroups the restored tool rows into its own component once the transcript is mounted
	const group = new TTool("bash");
	chat.children.splice(chat.children.indexOf(tool), 0, group);
	chat.render();

	assert.equal(shown(group), false, "the group is folded on the paint that follows the regroup");
	assert.equal(shown(answer), true, "the answer stays out of the fold");
	assert.equal(rowsOf(chat), 1, "still one row per turn");

	// the row opens the group it picked up, otherwise expanding the turn would show a gap
	const row = chat.children.find((child): child is SummaryLine => child instanceof SummaryLine);
	(row as SummaryLine).setExpanded(true);
	assert.equal(shown(group), true, "expanding the turn brings the group back");
	(row as SummaryLine).setExpanded(false);
	assert.equal(shown(group), false, "collapse folds it again");
});

test("a reloaded copy does not fold the restored history a second time", () => {
	reset();
	const chat = makeChat([new TUser(), new TTool("bash"), new TAssistant()]);
	const branch = [
		{ type: "custom", customType: "pi-turn-fold.turn", data: { ordinal: 0, ms: 4_200, outcome: "completed", expanded: false, tools: [{ name: "bash", failed: false }] } },
	];
	const ctx = { ui: {}, sessionManager: { getBranch: () => branch } };

	const first = load(foldFirst, __test, chat);
	first.fire("session_start", {}, ctx);
	assert.equal(rowsOf(chat), 1, "the restored turn is folded once");
	const toolCall = chat.children.find((child): child is TTool => child instanceof TTool);
	assert.equal(shown(toolCall as TTool), false, "and its tool call is behind the row");

	const again = load(foldAgain, second.__test, chat);
	again.fire("session_start", {}, ctx);
	assert.equal(rowsOf(chat), 1, "the second copy sees the first copy's fold and leaves the transcript alone");
});
