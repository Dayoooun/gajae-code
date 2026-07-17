import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@gajae-code/agent-core";
import type { CompactionOutcome } from "@gajae-code/agent-core/compaction";
import { type Model, modelsAreEqual } from "@gajae-code/ai";
import { Container, Markdown, Spacer, Text } from "@gajae-code/tui";
import { isEnoent, prompt } from "@gajae-code/utils";
import { resolveLocalUrlToPath } from "../../internal-urls";
import {
	humanizePlanTitle,
	type PlanApprovalDetails,
	renameApprovedPlanFile,
	resolvePlanTitle,
} from "../../plan-mode/approved-plan";
import planModeApprovedPrompt from "../../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import type { AgentSession, TemporaryProviderSessionScope } from "../../session/agent-session";
import type { SessionContext, SessionManager } from "../../session/session-manager";
import { normalizeLocalScheme } from "../../tools/path-utils";
import { type ResolveToolDetails, runResolveInvocation } from "../../tools/resolve";
import { ToolError } from "../../tools/tool-errors";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { DynamicBorder } from "../components/dynamic-border";
import { getMarkdownTheme } from "../theme/theme";
import type { SubmittedUserInput } from "../types";
import type { ModeGate } from "./mode-gate";

const ABORT_TIMEOUT_MS = 2_000;

type PlanModeControllerContext = {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly modeGate: ModeGate;
	readonly chatContainer: Container;
	readonly inputCallback: ((input: SubmittedUserInput) => void) | undefined;
	readonly externalEditorKey: string | undefined;
	startPendingSubmission(input: { text: string }): SubmittedUserInput;
	addChatChild(child: Container): void;
	requestRender(full?: boolean): void;
	stopUi(): void;
	startUi(): void;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	showHookConfirm(title: string, message: string): Promise<boolean>;
	showHookSelector(
		title: string,
		options: string[],
		options2?: { helpText?: string; onExternalEditor?: () => void },
	): Promise<string | undefined>;
	updatePlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void;
	handleClearCommand(): Promise<boolean>;
	handleCompactCommand(instructions?: string): Promise<CompactionOutcome>;
	updateEditorChrome(): void;
};

/** Owns plan-mode state, model scope, plan review, approval, and restoration. */
export class PlanModeController {
	#enabled = false;
	#paused = false;
	#planFilePath: string | undefined;
	#previousTools: string[] | undefined;
	#previousModelState: { model: Model; thinkingLevel?: ThinkingLevel } | undefined;
	#pendingModelSwitch: { model: Model; thinkingLevel?: ThinkingLevel } | undefined;
	#providerSessionScope: TemporaryProviderSessionScope | undefined;
	#hasEntered = false;
	#reviewContainer: Container | undefined;

	constructor(private readonly ctx: PlanModeControllerContext) {}
	get enabled(): boolean {
		return this.#enabled;
	}
	get paused(): boolean {
		return this.#paused;
	}
	get planFilePath(): string | undefined {
		return this.#planFilePath;
	}

	setEnabledForCompatibility(enabled: boolean): void {
		this.#enabled = enabled;
	}

	setPlanFilePathForCompatibility(planFilePath: string | undefined): void {
		this.#planFilePath = planFilePath;
	}

	clearReview(): void {
		this.#reviewContainer = undefined;
	}

	async restoreFromSession(sessionContext: SessionContext): Promise<void> {
		if (!this.ctx.session.settings.get("plan.enabled")) {
			if (sessionContext.mode === "plan" || sessionContext.mode === "plan_paused")
				this.ctx.sessionManager.appendModeChange("none");
			return;
		}
		if (sessionContext.mode === "plan") {
			await this.enter({ planFilePath: sessionContext.modeData?.planFilePath as string | undefined });
		} else if (sessionContext.mode === "plan_paused") {
			this.#paused = true;
			this.#hasEntered = true;
			this.ctx.modeGate.enter("plan");
			this.#updateStatus();
		}
	}

	async enter(options?: { planFilePath?: string; workflow?: "parallel" | "iterative" }): Promise<void> {
		if (this.#enabled) return;
		if (!this.ctx.modeGate.enter("plan")) return this.ctx.showWarning("Exit goal mode first.");
		this.#paused = false;
		const planFilePath = options?.planFilePath ?? "local://PLAN.md";
		const previousTools = this.ctx.session.getActiveToolNames();
		this.#previousTools = previousTools;
		this.#planFilePath = planFilePath;
		this.#enabled = true;
		await this.ctx.session.setActiveToolsByName(
			this.ctx.session.getToolByName("resolve") ? [...new Set([...previousTools, "resolve"])] : previousTools,
		);
		this.ctx.session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.#hasEntered,
		});
		this.ctx.session.setStandingResolveHandler?.(input => this.#runApprovalResolve(input));
		if (this.ctx.session.isStreaming) await this.ctx.session.sendPlanModeContext({ deliverAs: "steer" });
		this.#hasEntered = true;
		await this.#applyModel();
		this.#updateStatus();
		this.ctx.sessionManager.appendModeChange("plan", { planFilePath });
		this.ctx.showStatus(`Plan mode enabled. Plan file: ${planFilePath}`);
	}

	async exit(options?: { silent?: boolean; paused?: boolean }): Promise<void> {
		if (!this.#enabled) return;
		await this.ctx.session.abort({ timeoutMs: ABORT_TIMEOUT_MS });
		if (this.#previousTools?.length) await this.ctx.session.setActiveToolsByName(this.#previousTools);
		if (this.#providerSessionScope && !this.ctx.session.isStreaming) {
			if (this.ctx.session.restoreTemporaryProviderSessionScope(this.#providerSessionScope))
				this.#providerSessionScope = undefined;
		} else if (this.#previousModelState) {
			const previous = this.#previousModelState;
			if (modelsAreEqual(this.ctx.session.model, previous.model))
				this.ctx.session.setThinkingLevel(previous.thinkingLevel);
			else if (this.ctx.session.isStreaming) this.#pendingModelSwitch = previous;
			else
				await this.ctx.session.setModelTemporary(previous.model, previous.thinkingLevel, {
					cause: "restore",
					reason: "plan-mode",
				});
		}
		const pending = this.#pendingModelSwitch;
		const planModel = this.ctx.session.resolveRoleModelWithThinking("plan").model;
		if (pending && planModel && modelsAreEqual(pending.model, planModel)) this.#pendingModelSwitch = undefined;
		this.ctx.session.setStandingResolveHandler?.(null);
		this.ctx.session.setPlanModeState(undefined);
		this.#enabled = false;
		this.#paused = options?.paused ?? false;
		this.#planFilePath = undefined;
		this.#previousTools = undefined;
		this.#previousModelState = undefined;
		if (!this.#paused) this.ctx.modeGate.exit("plan");
		this.#updateStatus();
		this.ctx.sessionManager.appendModeChange(this.#paused ? "plan_paused" : "none");
		if (!options?.silent) this.ctx.showStatus(this.#paused ? "Plan mode paused." : "Plan mode disabled.");
	}

	async flushPendingModelSwitch(): Promise<void> {
		const pending = this.#pendingModelSwitch;
		if (!pending) return;
		this.#pendingModelSwitch = undefined;
		try {
			this.#providerSessionScope ??= this.ctx.session.beginTemporaryProviderSessionScope("plan-mode");
			await this.ctx.session.setModelTemporary(pending.model, pending.thinkingLevel, {
				cause: "temporary-operation",
				reason: "plan-mode",
				providerSessionScope: this.#providerSessionScope,
			});
		} catch (error) {
			if (this.#providerSessionScope)
				this.ctx.session.restoreTemporaryProviderSessionScope(this.#providerSessionScope);
			this.#providerSessionScope = undefined;
			this.ctx.showWarning(
				`Failed to switch model after streaming: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async handleCommand(initialPrompt?: string): Promise<void> {
		if (this.#enabled) {
			if (await this.ctx.showHookConfirm("Exit plan mode?", "This exits plan mode without approving a plan."))
				await this.exit({ paused: true });
			return;
		}
		if (!this.ctx.session.settings.get("plan.enabled"))
			return this.ctx.showWarning("Plan mode is disabled. Enable it in settings (plan.enabled).");
		await this.enter();
		if (initialPrompt && this.ctx.inputCallback)
			this.ctx.inputCallback(this.ctx.startPendingSubmission({ text: initialPrompt }));
	}

	async handleApproval(details: PlanApprovalDetails): Promise<void> {
		if (!this.#enabled) return this.ctx.showWarning("Plan mode is not active.");
		await this.ctx.session.abort({ timeoutMs: ABORT_TIMEOUT_MS });
		const planFilePath = details.planFilePath || this.#planFilePath || "local://PLAN.md";
		this.#planFilePath = planFilePath;
		const planContent = await this.#readFile(planFilePath);
		if (!planContent) return this.ctx.showError(`Plan file not found at ${planFilePath}`);
		this.#renderPreview(planContent, true);
		const choice = await this.ctx.showHookSelector(
			"Plan mode - next step",
			["Approve and execute", "Approve and compact context", "Approve and keep context", "Refine plan"],
			{ helpText: this.#helpText(), onExternalEditor: () => void this.#openEditor(planFilePath) },
		);
		if (!choice?.startsWith("Approve")) return;
		try {
			const latest = await this.#readFile(planFilePath);
			if (!latest) return this.ctx.showError(`Plan file not found at ${planFilePath}`);
			await this.#approve(latest, {
				planFilePath,
				finalPlanFilePath: details.finalPlanFilePath || planFilePath,
				title: details.title,
				preserveContext: choice !== "Approve and execute",
				compactBeforeExecute: choice === "Approve and compact context",
			});
		} catch (error) {
			this.ctx.showError(
				`Failed to finalize approved plan: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #applyModel(): Promise<void> {
		const resolved = this.ctx.session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;
		const current = this.ctx.session.model;
		const thinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;
		this.#previousModelState = current
			? { model: current, thinkingLevel: this.ctx.session.thinkingLevel }
			: undefined;
		if (modelsAreEqual(current, resolved.model)) {
			if (thinkingLevel) this.ctx.session.setThinkingLevel(thinkingLevel);
			return;
		}
		if (this.ctx.session.isStreaming) {
			this.#pendingModelSwitch = { model: resolved.model, thinkingLevel };
			return;
		}
		try {
			this.#providerSessionScope = this.ctx.session.beginTemporaryProviderSessionScope("plan-mode");
			await this.ctx.session.setModelTemporary(resolved.model, thinkingLevel, {
				cause: "temporary-operation",
				reason: "plan-mode",
				providerSessionScope: this.#providerSessionScope,
			});
		} catch (error) {
			if (this.#providerSessionScope)
				this.ctx.session.restoreTemporaryProviderSessionScope(this.#providerSessionScope);
			this.#providerSessionScope = undefined;
			this.ctx.showWarning(
				`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	#runApprovalResolve(input: unknown): Promise<AgentToolResult<ResolveToolDetails>> {
		return runResolveInvocation(input as Parameters<typeof runResolveInvocation>[0], {
			sourceToolName: "plan_approval",
			label: "Plan ready for approval",
			apply: async (_reason, extra) => {
				const state = this.ctx.session.getPlanModeState?.();
				if (!state?.enabled) throw new ToolError("Plan mode is not active.");
				const planContent = await this.#readFile(state.planFilePath);
				if (planContent === null)
					throw new ToolError(
						`Plan file not found at ${state.planFilePath}. Write the finalized plan to ${state.planFilePath} before requesting approval.`,
					);
				const normalized = resolvePlanTitle({
					suppliedTitle: extra?.title,
					planContent,
					planFilePath: state.planFilePath,
				});
				return {
					content: [{ type: "text", text: "Plan ready for approval." }],
					details: {
						planFilePath: state.planFilePath,
						finalPlanFilePath: `local://${normalized.fileName}`,
						title: normalized.title,
						planExists: true,
					},
				};
			},
		});
	}

	async #readFile(planFilePath: string): Promise<string | null> {
		try {
			return await Bun.file(this.#resolvePath(planFilePath)).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}
	#resolvePath(planFilePath: string): string {
		return planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(normalizeLocalScheme(planFilePath), {
					getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
					getSessionId: () => this.ctx.sessionManager.getSessionId(),
				})
			: path.resolve(this.ctx.sessionManager.getCwd(), planFilePath);
	}
	#renderPreview(content: string, append = false): void {
		const attached = this.#reviewContainer && this.ctx.chatContainer.children.includes(this.#reviewContainer);
		const container = !append && attached ? this.#reviewContainer! : new Container();
		container.clear();
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder());
		container.addChild(new Text("Plan Review", 1, 1));
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(content, 1, 1, getMarkdownTheme()));
		container.addChild(new DynamicBorder());
		if (container !== this.#reviewContainer || !attached) this.ctx.addChatChild(container);
		this.#reviewContainer = container;
		this.ctx.requestRender();
	}
	#helpText(): string {
		return this.ctx.externalEditorKey
			? `up/down navigate  enter select  ${this.ctx.externalEditorKey.toLowerCase()} open in editor  esc cancel`
			: "up/down navigate  enter select  esc cancel";
	}
	async #openEditor(planFilePath: string): Promise<void> {
		const command = getEditorCommand();
		if (!command) return this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
		const resolved = this.#resolvePath(planFilePath);
		let text: string;
		try {
			text = await Bun.file(resolved).text();
		} catch (error) {
			return isEnoent(error)
				? this.ctx.showError(`Plan file not found at ${planFilePath}`)
				: this.ctx.showWarning(`Failed to open external editor: ${String(error)}`);
		}
		let tty: fs.FileHandle | null = null;
		try {
			if (process.platform !== "win32") {
				try {
					tty = await fs.open("/dev/tty", "r+");
				} catch {}
			}
			this.ctx.stopUi();
			const result = await openInEditor(command, text, {
				extension: path.extname(resolved) || ".md",
				stdio: tty ? [tty.fd, tty.fd, tty.fd] : ["inherit", "inherit", "inherit"],
				trimTrailingNewline: false,
			});
			if (result !== null) {
				await Bun.write(resolved, result);
				this.#renderPreview(result);
				this.ctx.showStatus("Plan updated in external editor.");
			}
		} catch (error) {
			this.ctx.showWarning(`Failed to open external editor: ${String(error)}`);
		} finally {
			await tty?.close();
			this.ctx.startUi();
			this.ctx.requestRender(true);
		}
	}
	async #approve(
		planContent: string,
		options: {
			planFilePath: string;
			finalPlanFilePath: string;
			title: string;
			preserveContext: boolean;
			compactBeforeExecute: boolean;
		},
	): Promise<void> {
		await renameApprovedPlanFile({
			planFilePath: options.planFilePath,
			finalPlanFilePath: options.finalPlanFilePath,
			getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
			getSessionId: () => this.ctx.sessionManager.getSessionId(),
		});
		const previousTools = this.#previousTools ?? this.ctx.session.getActiveToolNames();
		let sessionSwitchCompleted = true;
		let compactOutcome: CompactionOutcome | undefined;
		if (options.compactBeforeExecute) this.ctx.session.markPlanCompactAbortPending();
		try {
			await this.exit({ silent: true });
			if (!options.preserveContext) {
				sessionSwitchCompleted = await this.ctx.handleClearCommand();
				if (sessionSwitchCompleted)
					await Bun.write(
						resolveLocalUrlToPath(options.finalPlanFilePath, {
							getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
							getSessionId: () => this.ctx.sessionManager.getSessionId(),
						}),
						planContent,
					);
			} else if (options.compactBeforeExecute) {
				this.ctx.session.setPlanReferencePath(options.finalPlanFilePath);
				compactOutcome = await this.ctx.handleCompactCommand(
					prompt.render(planModeCompactInstructionsPrompt, { planFilePath: options.finalPlanFilePath }),
				);
			}
		} finally {
			this.ctx.session.clearPlanCompactAbortPending();
		}
		if (previousTools.length) await this.ctx.session.setActiveToolsByName(previousTools);
		if (!sessionSwitchCompleted)
			return this.ctx.showWarning(
				"Plan approved, but the new session could not be created — execution was not dispatched.",
			);
		this.ctx.session.setPlanReferencePath(options.finalPlanFilePath);
		if (compactOutcome === "cancelled")
			return this.ctx.showWarning(
				"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
			);
		const name = humanizePlanTitle(options.title);
		if (
			name &&
			!this.ctx.sessionManager.getSessionName() &&
			(await this.ctx.sessionManager.setSessionName(name, "auto"))
		) {
			setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());
			this.ctx.updateEditorChrome();
		}
		this.ctx.session.markPlanReferenceSent();
		await this.ctx.session.prompt(
			prompt.render(planModeApprovedPrompt, {
				planContent,
				finalPlanFilePath: options.finalPlanFilePath,
				contextPreserved: options.preserveContext,
				tools: this.ctx.session.getActiveToolNames(),
			}),
			{ synthetic: true },
		);
	}
	#updateStatus(): void {
		this.ctx.updatePlanModeStatus(
			this.#enabled || this.#paused ? { enabled: this.#enabled, paused: this.#paused } : undefined,
		);
	}
}
