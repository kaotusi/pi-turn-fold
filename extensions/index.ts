import { AssistantMessageComponent, InteractiveMode, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Container } from "@earendil-works/pi-tui";
import { foldTurn, shouldFoldTurn, type FoldableComponent, type Fg } from "./fold.ts";

const HOOK = Symbol.for("pi-turn-fold.chat-hook");

interface Ui {
	theme?: { fg?: (color: string, text: string) => string };
	requestRender?(): void;
}

interface FoldState {
	chat?: Container;
	ui?: Ui;
	runStart?: number;
	outcome?: string;
}

const state: FoldState = {};

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
type AddMessageToChat = ((this: { chatContainer?: Container }, message: unknown, options?: unknown) => void) & {
	[HOOK]?: boolean;
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

function settle(aborted: boolean, outcome: string | undefined): void {
	const chat = state.chat;
	const children = chat?.children as FoldableComponent[] | undefined;
	const ms = state.runStart === undefined ? undefined : Date.now() - state.runStart;
	state.runStart = undefined;
	if (!Array.isArray(children) || !shouldFoldTurn(aborted, outcome)) return;
	const result = foldTurn({
		children,
		ToolClass: ToolExecutionComponent,
		AssistantClass: AssistantMessageComponent,
		UserClass: UserMessageComponent,
		ms,
		fg: fg(),
		onToggle: () => state.ui?.requestRender?.(),
	});
	if (!result) return;
	state.ui?.requestRender?.();
}

export default function piTurnFold(pi: ExtensionAPI): void {
	if (!installChatHook()) return;

	pi.on("session_start", (_event, ctx) => {
		rememberUi(ctx.ui as Ui);
		installChatHook();
	});

	pi.on("session_tree", (_event, ctx) => {
		rememberUi(ctx.ui as Ui);
	});

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
				settle(event.aborted, outcome);
			} catch (error) {
				warn("fold failed", error);
			}
		}, 0);
	});
}
