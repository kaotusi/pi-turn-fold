import { Spacer } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

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

/** Failed and interrupted turns stay verbatim: error rows must never disappear. */
export function shouldFoldTurn(aborted: boolean, outcome: string | undefined): boolean {
	return !aborted && (!outcome || outcome === "completed");
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
	fg: Fg;
	width: number;
}

/** ` ▸ took 42s · 9 calls · read×4 · bash×3` — one muted row, cc-style separators. */
export function buildSummaryLine({ expanded, ms, tools, fg, width }: SummaryLineInput): string {
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

export interface FoldTurnInput {
	children: FoldableComponent[];
	ToolClass: new (...args: never[]) => unknown;
	AssistantClass: new (...args: never[]) => unknown;
	UserClass: new (...args: never[]) => unknown;
	ms?: number;
	fg: Fg;
	onToggle?: (expanded: boolean) => void;
}

export interface FoldTurnResult {
	summary: SummaryLine;
	hidden: FoldableComponent[];
}

/** One clickable row standing in for a folded turn. */
export class SummaryLine implements FoldableComponent {
	expanded = false;
	private options: Omit<SummaryLineInput, "expanded" | "width">;
	private readonly onToggle?: (expanded: boolean) => void;
	private cache?: { width: number; line: string };

	constructor(options: Omit<SummaryLineInput, "expanded" | "width">, onToggle?: (expanded: boolean) => void) {
		this.options = options;
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

/**
 * Fold the last turn in place: hide everything between its user message and its reply
 * (tool rows, groups, intermediate messages, spacers), then park a summary row right
 * below the user message. Returns undefined when there is nothing worth folding.
 */
export function foldTurn({ children, ToolClass, AssistantClass, UserClass, ms, fg, onToggle }: FoldTurnInput): FoldTurnResult | undefined {
	let userIndex = -1;
	for (let index = children.length - 1; index >= 0; index--) {
		if (children[index] instanceof UserClass) {
			userIndex = index;
			break;
		}
	}
	if (userIndex < 0) return undefined;

	const interval = children.slice(userIndex + 1);
	const tools = interval.flatMap((component) => toolsOf(component, ToolClass));
	if (tools.length === 0) return undefined;

	const reply = [...interval].reverse().find((component) => isFinalReply(component, AssistantClass));
	const hidden = interval.filter((component) => component !== reply);

	const summary = new SummaryLine(
		{
			ms,
			tools: tools.map((tool) => ({
				name: String(tool.toolName ?? "tool"),
				failed: Boolean((tool.result as { isError?: boolean } | undefined)?.isError),			})),
			fg,
		},
		(expanded) => {
			for (const component of hidden) {
				if (expanded) showComponent(component);
				else hideComponent(component);
			}
			onToggle?.(expanded);
		},
	);

	for (const component of hidden) hideComponent(component);
	children.splice(userIndex + 1, 0, new Spacer(1), summary, new Spacer(1));
	return { summary, hidden };
}
