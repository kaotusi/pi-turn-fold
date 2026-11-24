import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";
import {
	buildSummaryLine,
	foldInterval,
	foldTurn,
	formatDuration,
	isFinalReply,
	lastUserIndex,
	nestedTools,
	SummaryLine,
	toolCounts,
	type FoldableComponent,
	type ToolEntry,
} from "../extensions/fold.ts";

class Tool implements FoldableComponent {
	toolName: string;
	result?: { isError?: boolean; details?: { calls?: Array<{ name: string; status?: string }> } };
	constructor(name: string, failed = false, result?: Tool["result"]) {
		this.toolName = name;
		this.result = { ...(failed ? { isError: true } : {}), ...result };
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

function fold(children: FoldableComponent[], ms = 42_000, outcome?: string) {
	return foldTurn({
		children,
		ToolClass: Tool,
		AssistantClass: Assistant,
		UserClass: User,
		ms,
		outcome,
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
	assert.equal(result.record.ordinal, 0);
});

test("clicking the summary expands the folded rows under a rail, clicking again folds them back", () => {
	const tool = new Tool("read");
	const children: FoldableComponent[] = [new User(), tool, reply];
	const result = fold(children);
	assert.ok(result);
	assert.deepEqual(tool.render(80), []);

	result.summary.handleMouse?.({ type: "click", button: "left" });
	assert.deepEqual(tool.render(80), ["│ tool read"]);
	assert.deepEqual(result.summary.render(80), [" ▾ took 42s · 1 call · read×1"]);
	assert.equal(result.record.expanded, true);

	result.summary.handleMouse?.({ type: "click", button: "left" });
	assert.deepEqual(tool.render(80), []);
	assert.deepEqual(result.summary.render(80), [" ▸ took 42s · 1 call · read×1"]);
	assert.equal(result.record.expanded, false);
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

test("nested calls are counted under their host tool", () => {
	const codemode = new Tool("codemode", false, {
		details: {
			calls: [
				{ name: "bash", status: "ok" },
				{ name: "bash", status: "ok" },
				{ name: "bash", status: "error" },
				{ name: "read", status: "ok" },
				{ name: "read", status: "ok" },
			],
		},
	});
	const children: FoldableComponent[] = [new User(), codemode, reply];
	const result = fold(children);
	assert.ok(result);
	assert.deepEqual(result.summary.render(120), [" ▸ took 42s · 1 call · codemode×1 (bash×3 read×2)"]);
	assert.deepEqual(nestedTools(codemode.result), [["bash", 3], ["read", 2]]);
	assert.equal(nestedTools(new Tool("bash").result), undefined);
});

test("a narrow summary drops the nested counts before truncating", () => {
	const line = buildSummaryLine({
		expanded: false,
		ms: 4000,
		tools: [{ name: "codemode", failed: false, nested: [["bash", 3]] }],
		fg: plainFg,
		width: 40,
	});
	assert.deepEqual(line, " ▸ took 4s · 1 call · codemode×1");
});

test("failures are visible on the folded line", () => {
	const children: FoldableComponent[] = [new User(), new Tool("bash", true), new Tool("bash"), reply];
	const result = fold(children);
	assert.ok(result);
	assert.deepEqual(result.summary.render(80), [" ▸ took 42s · 2 calls · bash×2 · 1 failed"]);
});

test("failed and interrupted turns fold too, and say so", () => {
	const errorReply = new Assistant([{ type: "text", text: "boom" }]);
	const tool = new Tool("bash", true);
	const children: FoldableComponent[] = [new User(), tool, errorReply];
	const result = fold(children, 9000, "error");
	assert.ok(result);
	assert.deepEqual(result.summary.render(80), [" ▸ took 9s · 1 call · bash×1 · 1 failed · error"]);
	assert.deepEqual(tool.render(80), [], "the error row is hidden until expanded");
	result.summary.handleMouse?.({ type: "click", button: "left" });
	assert.deepEqual(tool.render(80), ["│ tool bash"], "expanding shows the failure row again");
	assert.deepEqual(errorReply.render(80), ["assistant"], "the error text stays visible");
});

test("a restored fold starts expanded with the saved counts and no components to derive them from", () => {
	const tool = new Tool("bash");
	const children: FoldableComponent[] = [new User(), tool, reply];
	const saved: ToolEntry[] = [{ name: "codemode", failed: false, nested: [["bash", 1]] }];
	const result = foldInterval({
		children,
		userIndex: 0,
		ToolClass: Tool,
		AssistantClass: Assistant,
		UserClass: User,
		ms: 4000,
		tools: saved,
		expanded: true,
		fg: plainFg,
	});
	assert.ok(result);
	assert.deepEqual(result.summary.render(120), [" ▾ took 4s · 1 call · codemode×1 (bash×1)"]);
	assert.deepEqual(tool.render(80), ["│ tool bash"], "restored expanded turn keeps its rows, railed");
});

test("a turn stops at the next user message: later turns are not swallowed", () => {
	const firstTool = new Tool("read");
	const secondTool = new Tool("bash");
	const secondReply = new Assistant([{ type: "text", text: "second" }]);
	const children: FoldableComponent[] = [new User(), firstTool, reply, new User(), secondTool, secondReply];
	const result = foldInterval({
		children,
		userIndex: 0,
		ToolClass: Tool,
		AssistantClass: Assistant,
		UserClass: User,
		ms: 1000,
		fg: plainFg,
	});
	assert.ok(result);
	assert.deepEqual(firstTool.render(80), [], "the folded turn's tool row is hidden");
	assert.deepEqual(reply.render(80), ["assistant"], "its own reply stays");
	assert.deepEqual(secondTool.render(80), ["tool bash"], "the next turn is untouched");
	assert.deepEqual(secondReply.render(80), ["assistant"]);
	assert.equal(children.length, 6 + 3);
});

test("the ordinal counts user messages up to this turn", () => {
	const first: FoldableComponent[] = [new User(), new Tool("read"), reply];
	assert.ok(fold(first));
	const children: FoldableComponent[] = [new User(), new Tool("read"), reply, new User(), new Tool("bash"), new Assistant([{ type: "text", text: "ok" }])];
	const result = fold(children);
	assert.ok(result);
	assert.equal(result.record.ordinal, 1);
	assert.equal(lastUserIndex(children, User) > 0, true);
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
