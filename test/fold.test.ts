import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";
import {
	buildSummaryLine,
	foldTurn,
	formatDuration,
	isFinalReply,
	shouldFoldTurn,
	SummaryLine,
	toolCounts,
	type FoldableComponent,
} from "../extensions/fold.ts";

class Tool implements FoldableComponent {
	toolName: string;
	result?: { isError: boolean };
	constructor(name: string, failed = false) {
		this.toolName = name;
		if (failed) this.result = { isError: true };
	}
	render(_width: number): string[] {
		return [`tool ${this.toolName}`];
	}
	invalidate(): void {}
}

class Assistant implements FoldableComponent {
	lastMessage: { content: Array<{ type: string; text?: string }> };
	children: FoldableComponent[] = [];
	constructor(content: Array<{ type: string; text?: string }>) {
		this.lastMessage = { content };
	}
	render(_width: number): string[] {
		return ["assistant"];
	}
	invalidate(): void {}
}

class User implements FoldableComponent {
	render(_width: number): string[] {
		return ["user"];
	}
	invalidate(): void {}
}

class Group implements FoldableComponent {
	toolName = "Tool group";
	toolCallId = "group-1";
	children: FoldableComponent[];
	constructor(children: FoldableComponent[]) {
		this.children = children;
	}
	render(_width: number): string[] {
		return ["group"];
	}
	invalidate(): void {}
}

const plainFg = (_color: string, text: string): string => text;

function fold(children: FoldableComponent[], ms = 42_000) {
	return foldTurn({
		children,
		ToolClass: Tool,
		AssistantClass: Assistant,
		UserClass: User,
		ms,
		fg: plainFg,
	});
}

const reply = new Assistant([{ type: "text", text: "done" }]);

test("hides the process, keeps the reply, parks one summary under the user message", () => {
	const children: FoldableComponent[] = [
		new User(),
		new Tool("read"),
		new Tool("bash"),
		new Assistant([{ type: "toolCall" }]),
		reply,
	];
	const before = children.length;
	const result = fold(children);
	assert.ok(result);
	assert.equal(children.length, before + 3, "two spacers + summary inserted, nothing removed");
	assert.equal(children[0] instanceof User, true);
	assert.ok(children[2] instanceof SummaryLine);
	assert.deepEqual(children[2].render(80), [" ▸ took 42s · 2 calls · read×1 · bash×1"]);
	assert.deepEqual(children[1].render(80), [""], "spacer above the summary");
	assert.deepEqual(children[3].render(80), [""], "spacer below the summary");
	for (const hidden of result.hidden) assert.deepEqual(hidden.render(80), []);
	assert.deepEqual(reply.render(80), ["assistant"], "reply stays visible");
	assert.equal(result.hidden.includes(reply), false);
});

test("clicking the summary expands the folded rows, clicking again folds them back", () => {
	const tool = new Tool("read");
	const children: FoldableComponent[] = [new User(), tool, reply];
	const result = fold(children);
	assert.ok(result);
	assert.deepEqual(tool.render(80), []);

	result.summary.handleMouse?.({ type: "click", button: "left" });
	assert.deepEqual(tool.render(80), ["tool read"]);
	assert.deepEqual(result.summary.render(80), [" ▾ took 42s · 1 call · read×1"]);

	result.summary.handleMouse?.({ type: "click", button: "left" });
	assert.deepEqual(tool.render(80), []);
	assert.deepEqual(result.summary.render(80), [" ▸ took 42s · 1 call · read×1"]);
});

test("no tool call means nothing to fold", () => {
	assert.equal(fold([new User(), reply]), undefined);
	assert.equal(fold([new User()]), undefined);
	assert.equal(fold([new Tool("read"), reply]), undefined, "no user message in the container");
});

test("a tool group counts as its inner tools", () => {
	const group = new Group([new Tool("bash"), new Tool("bash"), new Tool("grep")]);
	const children: FoldableComponent[] = [new User(), group, reply];
	const result = fold(children);
	assert.ok(result);
	assert.deepEqual(result.summary.render(80), [" ▸ took 42s · 3 calls · bash×2 · grep×1"]);
	assert.deepEqual(group.render(80), []);
});

test("failures are visible on the folded line", () => {
	const children: FoldableComponent[] = [new User(), new Tool("bash", true), new Tool("bash"), reply];
	const result = fold(children);
	assert.ok(result);
	assert.deepEqual(result.summary.render(80), [" ▸ took 42s · 2 calls · bash×2 · 1 failed"]);
});

test("expanded state survives a re-render at the same width", () => {
	const summary = fold([new User(), new Tool("read"), reply])?.summary;
	assert.ok(summary);
	assert.deepEqual(summary.render(80), [" ▸ took 42s · 1 call · read×1"]);
	summary.setExpanded(true);
	assert.deepEqual(summary.render(80), [" ▾ took 42s · 1 call · read×1"]);
});

test("final reply detection", () => {
	assert.equal(isFinalReply(new Assistant([{ type: "text", text: "hi" }]), Assistant), true);
	assert.equal(isFinalReply(new Assistant([{ type: "text", text: "hi" }, { type: "toolCall" }]), Assistant), false);
	assert.equal(isFinalReply(new Assistant([{ type: "text", text: "  " }]), Assistant), false);
	assert.equal(isFinalReply(new User(), Assistant), false);
});

test("failed and interrupted turns are left verbatim", () => {
	assert.equal(shouldFoldTurn(false, "completed"), true);
	assert.equal(shouldFoldTurn(false, undefined), true);
	assert.equal(shouldFoldTurn(true, "completed"), false);
	assert.equal(shouldFoldTurn(false, "error"), false);
	assert.equal(shouldFoldTurn(false, "aborted"), false);
});

test("summary line formatting", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(500), "1s");
	assert.equal(formatDuration(42_400), "42s");
	assert.equal(formatDuration(62_000), "1m02s");
	assert.equal(formatDuration(undefined), "0s");
	assert.deepEqual(toolCounts([{ name: "b", failed: false }, { name: "a", failed: false }, { name: "b", failed: true }]), [
		["b", 2],
		["a", 1],
	]);
	const long = buildSummaryLine({
		expanded: false,
		ms: 1000,
		tools: [{ name: "read", failed: false }, { name: "bash", failed: false }],
		fg: plainFg,
		width: 12,
	});
	assert.ok(visibleWidth(long) <= 12, `narrow width truncated: ${JSON.stringify(long)}`);
	assert.equal(buildSummaryLine({ expanded: false, ms: 0, tools: [], fg: plainFg, width: 0 }), "");
});
