import { Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Minimal component shape shared by pi-tui components and the fakes in tests. */
export interface FoldableComponent {
	render(width: number): readonly string[];
	invalidate?(): void;
	handleMouse?(event: MouseEvent): MouseEventResult | undefined;
	children?: unknown;
	lastMessage?: unknown;
	toolName?: unknown;
	result?: unknown;
}

export interface MouseEvent {
	type: string;
	button: string;
}

export interface MouseEventResult {
	handled?: boolean;
	render?: boolean;
}

/** One tool call as it appears in a summary. */
export interface ToolEntry {
	name: string;
	failed: boolean;
}

export type Fg = (color: string, text: string) => string;

const originalRenders = new WeakMap<FoldableComponent, (width: number) => readonly string[]>();

/** Replace a component's rows with nothing, remembering the original renderer. */
export function hideComponent(component: FoldableComponent | undefined): void {
	if (!component || typeof component.render !== "function" || originalRenders.has(component)) return;
	originalRenders.set(component, component.render);
	component.render = () => [];
	component.invalidate?.();
}

export function showComponent(component: FoldableComponent | undefined): void {
	if (!component) return;
	const original = originalRenders.get(component);
	if (!original) return;
	component.render = original;
	originalRenders.delete(component);
	component.invalidate?.();
}

/** Tools rendered by one entry: either a bare tool component or a group (cc-style) of them. */
export function toolsOf(component: FoldableComponent | undefined, ToolClass: new (...args: never[]) => unknown): FoldableComponent[] {
	if (!component) return [];
	if (component instanceof ToolClass) return [component];
	const children = component.children;
	if (!Array.isArray(children)) return [];
	return (children as FoldableComponent[]).filter((child) => child instanceof ToolClass);
}

/** The turn's answer: an assistant message with visible text and no pending tool call. */
export function isFinalReply(component: FoldableComponent | undefined, AssistantClass: new (...args: never[]) => unknown): boolean {
	if (!component || !(component instanceof AssistantClass)) return false;
	const message = component.lastMessage as { content?: Array<{ type: string; text?: string }> } | undefined;
	const blocks = Array.isArray(message?.content) ? message.content : [];
	const hasText = blocks.some((block) => block.type === "text" && (block.text ?? "").trim() !== "");
	const hasToolCall = blocks.some((block) => block.type === "toolCall");
	return hasText && !hasToolCall;
}

/** `42s`, `1m02s`; a missing start time reads as `0s`. */
export function formatDuration(ms: number | undefined): string {
	const seconds = Math.max(0, Math.round((ms ?? 0) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Tool calls by name, in order of first appearance. */
export function toolCounts(tools: readonly ToolEntry[]): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
	return [...counts];
}

export interface SummaryLineInput {
	expanded: boolean;
	ms?: number;
	tools: readonly ToolEntry[];
	outcome?: string;
	fg: Fg;
	width: number;
}

/** ` ▸ took 42s · 9 calls · read×4 · bash×3` — one muted row, cc-style separators. */
export function buildSummaryLine({ expanded, ms, tools, outcome: _outcome, fg, width }: SummaryLineInput): string {
	if (!(width > 0)) return "";
	const parts = [
		fg("muted", `${expanded ? "▾" : "▸"} took ${formatDuration(ms)}`),
		fg("muted", `${tools.length} ${tools.length === 1 ? "call" : "calls"}`),
	];
	for (const [name, count] of toolCounts(tools)) parts.push(fg("muted", `${name}×${count}`));
	const failed = tools.filter((tool) => tool.failed).length;
	if (failed > 0) parts.push(fg("error", `${failed} failed`));
	return truncateToWidth(` ${parts.join(fg("muted", " · "))}`, width, "…");
}

/** What a folded turn persists, so a reopened session can restore the fold. */
export interface FoldRecord {
	ordinal: number;
	ms?: number;
	outcome?: string;
	tools: ToolEntry[];
	expanded: boolean;
}

/** One clickable row standing in for a folded turn. */
export class SummaryLine implements FoldableComponent {
	expanded = false;
	private readonly options: Omit<SummaryLineInput, "width">;
	private readonly onToggle?: (expanded: boolean) => void;
	private cache?: { width: number; line: string };

	constructor(options: Omit<SummaryLineInput, "width">, onToggle?: (expanded: boolean) => void) {
		this.options = options;
		this.expanded = options.expanded;
		this.onToggle = onToggle;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.invalidate();
		this.onToggle?.(expanded);
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return [this.cache.line];
		const line = buildSummaryLine({ ...this.options, expanded: this.expanded, width });
		this.cache = { width, line };
		return [line];
	}

	handleMouse(event: MouseEvent): MouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.setExpanded(!this.expanded);
		return { handled: true, render: true };
	}
}

export interface FoldInput {
	children: FoldableComponent[];
	userIndex: number;
	ToolClass: new (...args: never[]) => unknown;
	AssistantClass: new (...args: never[]) => unknown;
	UserClass: new (...args: never[]) => unknown;
	ms?: number;
	outcome?: string;
	/** Saved calls (restore path); derived from the components when absent. */
	tools?: readonly ToolEntry[];
	expanded?: boolean;
	fg: Fg;
	onToggle?: (expanded: boolean) => void;
}

export interface FoldResult {
	summary: SummaryLine;
	hidden: FoldableComponent[];
	record: FoldRecord;
}

/** Hide everything between one user message and its reply, leaving a summary row below the user message. */
export function foldInterval({ children, userIndex, ToolClass, AssistantClass, UserClass, ms, outcome, tools, expanded = false, fg, onToggle }: FoldInput): FoldResult | undefined {
	if (userIndex < 0 || userIndex >= children.length) return undefined;
	// a turn ends at the next user message: later turns are their own folds
	const next = children.findIndex((component, index) => index > userIndex && component instanceof UserClass);
	const interval = children.slice(userIndex + 1, next < 0 ? children.length : next);
	const entries: ToolEntry[] = tools
		? [...tools]
		: interval.flatMap((component) => toolsOf(component, ToolClass)).map((tool) => ({
				name: String(tool.toolName ?? "tool"),
				failed: Boolean((tool.result as { isError?: boolean } | undefined)?.isError),
			}));
	return foldWith({ children, userIndex, interval, tools: entries, ms, outcome, expanded, fg, onToggle, AssistantClass, UserClass });
}

interface FoldWithInput {
	children: FoldableComponent[];
	userIndex: number;
	interval: FoldableComponent[];
	tools: readonly ToolEntry[];
	ms?: number;
	outcome?: string;
	expanded: boolean;
	fg: Fg;
	onToggle?: (expanded: boolean) => void;
	AssistantClass: new (...args: never[]) => unknown;
	UserClass: new (...args: never[]) => unknown;
}

function foldWith({ children, userIndex, interval, tools, ms, outcome, expanded, fg, onToggle, AssistantClass, UserClass }: FoldWithInput): FoldResult | undefined {
	if (tools.length === 0) return undefined;
	const reply = [...interval].reverse().find((component) => isFinalReply(component, AssistantClass));
	const hidden = interval.filter((component) => component !== reply);
	const ordinal = children.slice(0, userIndex + 1).filter((component) => component instanceof UserClass).length - 1;
	const record: FoldRecord = { ordinal, ms, outcome, tools: [...tools], expanded };
	const summary = new SummaryLine({ ...record, fg }, (next) => {
		record.expanded = next;
		for (const component of hidden) {
			if (next) showComponent(component);
			else hideComponent(component);
		}
		onToggle?.(next);
	});
	for (const component of hidden) {
		if (!expanded) hideComponent(component);
	}
	children.splice(userIndex + 1, 0, new Spacer(1), summary, new Spacer(1));
	return { summary, hidden, record };
}

/** Index of the newest user message, or -1. */
export function lastUserIndex(children: readonly FoldableComponent[], UserClass: new (...args: never[]) => unknown): number {
	for (let index = children.length - 1; index >= 0; index--) {
		if (children[index] instanceof UserClass) return index;
	}
	return -1;
}

/** Fold the last turn in place. Returns undefined when it holds no tool call. */
export function foldTurn(input: Omit<FoldInput, "userIndex" | "tools" | "expanded">): FoldResult | undefined {
	return foldInterval({ ...input, userIndex: lastUserIndex(input.children, input.UserClass) });
}
