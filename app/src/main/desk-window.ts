import { BaseWindow, dialog, ipcMain, session, shell, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { CHANNELS, type ShellAction, type ShellState } from "../shared/shell-state.ts";
import type { Locale } from "../shared/locale.ts";
import { isAccountAction, type AccountAction } from "../shared/accounts.ts";
import { isRecipeAction, type RecipeAction } from "../shared/recipe-update.ts";
import { isComputerAction, isDiagnosticsAction, type ComputerAction, type DiagnosticsAction } from "../shared/computer.ts";
import { isUpdateAction, type UpdateAction } from "../shared/updates.ts";
import { SETTINGS_SECTIONS, type SettingsAction, type SettingsSection, type SettingsView, type ShellNotice, type WizardAction, type WizardView } from "../shared/wizard.ts";
import { dialogTitle, externalLink, guiOriginOf, guiPortOf, isGuiUrl, permissionAllowed } from "./page-security.ts";
import { closeWindowViews, type GuiSurface } from "./gui-presenter.ts";
import { RENDERER_GONE_MAX, RENDERER_GONE_WINDOW_MS, SlidingBudget } from "./runtime/budget.ts";
import { backgroundOf, type GuiView } from "./runtime/follow.ts";
import type { RuntimeEvent } from "./runtime/log.ts";

// The app's window (spec: Decisions, Window; Runtime supervisor, Window and page security, Crash and sleep): one `BaseWindow` with two `WebContentsView`s, the GUI view (pi-straw-boss)
// and the shell view above it (the wizard; the runtime page for a notice or a screen; the settings). This file is Electron wiring only: every rule that decides something is a pure function in
// `page-security.ts`, `shell-state.ts` or `runtime/budget.ts`, with its own unit tests, and the e2e test checks that the wiring calls them.

/** A notice over the GUI is a strip this high; the GUI view gives it the room, so nothing under it is covered. */
const BANNER_HEIGHT = 44;
/** The notice strip never grows past this, whatever the page measures. */
const MAX_STRIP_HEIGHT = 240;

export interface DeskWindowDeps {
	productName: string;
	locale: string;
	build: string;
	/** `dist/` (the folder holding `preload/` and `renderer/`). */
	distDir: string;
	/** The work folder: the folder dialog opens there. */
	workFolder(): string;
	/** The runtime page's requests: **Start**, **Try again**, **Repair**, and a notice's buttons (the ones about the window itself are handled here and not passed). */
	onAction(action: ShellAction): void;
	/** The wizard's state and its requests. */
	wizardView(): WizardView;
	onWizardAction(action: WizardAction): Promise<void>;
	/** The settings page's state. */
	settingsView(section: SettingsSection): SettingsView;
	/** Settings shows a section (opened, or chosen in its list): the Accounts rows ask the store again. */
	onSettingsShown?(section: SettingsSection): void;
	/** A request of settings' Accounts section (sign in again, sign out, the token, Claude's code, Linear's key); the wizard's own go through `onWizardAction`. */
	onAccountAction(action: AccountAction): Promise<void>;
	/** A request of settings' Updates section (check now, apply, restart to update, download, show) and the banner's **Restart to update**. */
	onUpdateAction(action: UpdateAction): Promise<void>;
	/** A request of settings' Team recipe card (check now, apply, keep, replace, retry a repository). */
	onRecipeAction(action: RecipeAction): Promise<void>;
	/** A request of settings' Computer section (keep awake, Remove all data). */
	onComputerAction(action: ComputerAction): Promise<void>;
	/** A request of settings' Diagnostics section (status, logs, collect, repair). */
	onDiagnosticsAction(action: DiagnosticsAction): Promise<void>;
	/** Windows log off or shutdown (`session-end`): the stop that fits in the time Windows gives. */
	onSessionEnd(): void;
	log: RuntimeEvent;
}

export class DeskWindow {
	readonly #d: DeskWindowDeps;
	#window: BaseWindow | undefined;
	#gui: WebContentsView | undefined;
	#shell: WebContentsView | undefined;
	/** The page the shell view has loaded: the wizard (also the short wait of a later launch), the runtime page, or the settings. */
	#page: "wizard" | "screen" | "settings" | null = null;
	/** The wizard has not finished: its page stays over the GUI view through the sign-in steps. */
	#wizardActive = false;
	#settingsOpen = false;
	#section: SettingsSection = "accounts";
	#locale: Locale;
	#notices: ShellNotice[] = [];
	/** The height of the notice strip as the page measured it. */
	#stripHeight = BANNER_HEIGHT;
	#state: ShellState = { mode: "none" };
	/** The GUI view has been given an address: the shell view stays out of the way unless it has something to say. */
	#guiShown = false;
	/** The address the GUI view shows, with its page token: in memory only, for a reload after the renderer went away. */
	#address: string | null = null;
	#origin: string | null = null;
	#background = backgroundOf(undefined);
	readonly #gone = new SlidingBudget(RENDERER_GONE_MAX, RENDERER_GONE_WINDOW_MS);

	constructor(deps: DeskWindowDeps) {
		this.#d = deps;
		this.#locale = deps.locale === "zh-TW" ? "zh-TW" : "en";
		this.#registerIpc();
		this.#restrictPermissions();
	}

	get window(): BaseWindow | undefined {
		return this.#window;
	}

	get isOpen(): boolean {
		return this.#window !== undefined && !this.#window.isDestroyed();
	}

	/** Opens the window with its two views. The caller then attaches the presenter's surface. */
	open(onClosed: () => void): GuiSurface {
		const { distDir } = this.#d;
		const window = new BaseWindow({ width: 1280, height: 860, minWidth: 720, minHeight: 520, title: this.#d.productName, backgroundColor: this.#background });
		this.#window = window;
		this.#page = null;
		this.#guiShown = false;

		// The GUI stays loaded under any shell screen or banner, so it is added first and the shell view sits above it.
		const gui = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(distDir, "preload", "gui.cjs") } });
		gui.setBackgroundColor(this.#background);
		const shellView = new WebContentsView({
			webPreferences: {
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				preload: join(distDir, "preload", "shell.cjs"),
				additionalArguments: [`--sbd-locale=${this.#locale}`, `--sbd-product=${this.#d.productName}`, `--sbd-build=${this.#d.build}`],
			},
		});
		this.#gui = gui;
		this.#shell = shellView;
		window.contentView.addChildView(gui);
		window.contentView.addChildView(shellView);
		this.#guardGui(gui);
		this.#guardShell(shellView);
		this.#layout();
		window.on("resize", () => this.#layout());
		// Windows log off or shutdown: `cli.mjs stop` for 10 s, run to the end here, and Windows ends the rest.
		window.on("session-end", () => this.#d.onSessionEnd());
		const views = [gui, shellView];
		window.on("closed", () => {
			// The views outlive their window on macOS, where the app keeps running: close their pages so a reopen does not pile up hidden GUI pages (R8A-F003).
			closeWindowViews(views);
			if (this.#window === window) {
				this.#window = undefined;
				this.#gui = undefined;
				this.#shell = undefined;
			}
			onClosed();
		});
		this.#applyState();
		return {
			show: (url, onLoaded) => this.#showGui(url, onLoaded),
		};
	}

	/**
	 * Blank until the supervisor loads the GUI: a view that never navigates has no renderer, which a CDP client such as Playwright waits on forever. Called when the window opened with
	 * no GUI to show yet.
	 */
	blank(): void {
		void this.#gui?.webContents.loadURL("about:blank").catch(() => undefined);
	}

	/** Loads the GUI's address in the GUI view and takes the shell view out of the way. */
	#showGui(url: string, onLoaded: () => void): void {
		const gui = this.#gui;
		if (gui === undefined || gui.webContents.isDestroyed()) return;
		this.#address = url;
		this.#origin = guiOriginOf(url);
		this.#guiShown = true;
		this.#state = { mode: "none" };
		gui.webContents.once("did-finish-load", onLoaded);
		void gui.webContents.loadURL(url).catch((error: Error) => this.#d.log({ event: "gui-load-failed", detail: error.message.slice(0, 200) }));
		this.#applyState();
	}

	/** The server's default view: the window and the GUI view are painted in its colour before the page loads, and again when it changes. */
	setView(view: GuiView | undefined): void {
		this.#background = backgroundOf(view);
		if (this.isOpen) this.#window?.setBackgroundColor(this.#background);
		this.#gui?.setBackgroundColor(this.#background);
	}

	/** What the shell view shows: nothing, a notice over the GUI, or a whole screen. */
	setState(state: ShellState): void {
		this.#state = state;
		this.#applyState();
	}

	/** Takes a notice away; a screen stays until the GUI is shown. */
	clearBanner(): void {
		if (this.#state.mode === "banner") this.setState({ mode: "none" });
	}

	/** The notices that stay over the GUI until dealt with (the WSL sentence, the sign-ins put off). */
	setNotices(notices: ShellNotice[]): void {
		this.#notices = notices;
		this.#applyState();
	}

	get notices(): readonly ShellNotice[] {
		return this.#notices;
	}

	/** The wizard has not finished (true) or has (false). While it has not, its page covers the GUI view. */
	setWizardActive(active: boolean): void {
		this.#wizardActive = active;
		this.#applyState();
	}

	/** The wizard's state changed: the wizard page hears it. */
	pushWizard(view: WizardView): void {
		if (this.#page === "wizard") this.#send(CHANNELS.wizardChanged, view);
	}

	/** The settings' state changed (a sign-in put off, a new language). */
	pushSettings(): void {
		if (this.#page === "settings") this.#send(CHANNELS.settingsChanged, this.#d.settingsView(this.#section));
	}

	/** The interface language changed: every shell page follows. */
	setLocale(locale: Locale): void {
		if (locale === this.#locale) return;
		this.#locale = locale;
		this.#send(CHANNELS.localeChanged, locale);
	}

	get settingsOpen(): boolean {
		return this.#settingsOpen;
	}

	openSettings(section: SettingsSection = "accounts"): void {
		this.#section = section;
		this.#settingsOpen = true;
		this.#applyState();
		this.#d.onSettingsShown?.(section);
	}

	closeSettings(): void {
		if (!this.#settingsOpen) return;
		this.#settingsOpen = false;
		this.#applyState();
	}

	#send(channel: string, payload: unknown): void {
		const contents = this.#shell?.webContents;
		if (contents !== undefined && !contents.isDestroyed()) contents.send(channel, payload);
	}

	/** The state the runtime page shows: a screen or a restart notice first, else the notices that stay. */
	#effective(): ShellState {
		if (this.#state.mode === "screen" || this.#state.mode === "banner") return this.#state;
		return this.#notices.length > 0 ? { mode: "notices", notices: this.#notices } : { mode: "none" };
	}

	/** Which page the shell view should show, by what is going on. */
	#wantedPage(): "wizard" | "screen" | "settings" | "hidden" {
		if (this.#settingsOpen) return "settings";
		if (this.#wizardActive) return "wizard";
		const state = this.#effective();
		if (state.mode === "screen") return "screen";
		if (!this.#guiShown) return state.mode === "none" ? "wizard" : "screen";
		return state.mode === "none" ? "hidden" : "screen";
	}

	#load(page: "wizard" | "screen" | "settings"): void {
		const shellView = this.#shell;
		if (shellView === undefined || shellView.webContents.isDestroyed()) return;
		this.#page = page;
		void shellView.webContents.loadFile(join(this.#d.distDir, "renderer", `${page}.html`));
	}

	#applyState(): void {
		const shellView = this.#shell;
		if (shellView === undefined || shellView.webContents.isDestroyed()) return;
		const wanted = this.#wantedPage();
		if (wanted === "hidden") {
			shellView.setVisible(false);
			this.#layout();
			return;
		}
		if (this.#page !== wanted) this.#load(wanted);
		else if (wanted === "screen") shellView.webContents.send(CHANNELS.stateChanged, this.#effective());
		else if (wanted === "settings") this.pushSettings();
		shellView.setVisible(true);
		this.#layout();
	}

	/** True when the shell view is a strip over the GUI, not a whole page. */
	#stripMode(): boolean {
		const state = this.#effective();
		return this.#wantedPage() === "screen" && this.#guiShown && (state.mode === "banner" || state.mode === "notices");
	}

	#layout(): void {
		const window = this.#window;
		if (window === undefined || window.isDestroyed()) return;
		const { width, height } = window.getContentBounds();
		const strip = this.#stripMode();
		const stripHeight = strip ? (this.#effective().mode === "notices" ? this.#stripHeight : BANNER_HEIGHT) : 0;
		this.#gui?.setBounds({ x: 0, y: stripHeight, width, height: Math.max(0, height - stripHeight) });
		this.#shell?.setBounds(strip ? { x: 0, y: 0, width, height: stripHeight } : { x: 0, y: 0, width, height });
	}

	// ---- the GUI view's page security -----------------------------------------------------------------------------------

	#guardGui(gui: WebContentsView): void {
		const contents = gui.webContents;
		// Navigation stays on the GUI's origin. A blocked navigation is cancelled, and an allowed link opens in the default browser; the GUI view stays where it was.
		const leave = (event: { preventDefault(): void }, url: string): void => {
			if (isGuiUrl(url, this.#origin)) return;
			event.preventDefault();
			this.#external(url, "navigate");
		};
		contents.on("will-navigate", (event, url) => leave(event, url));
		contents.on("will-redirect", (event, url) => leave(event, url));
		contents.setWindowOpenHandler(({ url }) => {
			this.#external(url, "window-open");
			return { action: "deny" };
		});
		// The renderer went away: load the current address again; a second loss within a minute shows the failure screen.
		contents.on("render-process-gone", (_event, details) => {
			this.#d.log({ event: "gui-renderer-gone", reason: details.reason, exitCode: details.exitCode });
			if (this.#gone.hit(Date.now())) {
				this.setState({ mode: "screen", screen: "failed", failure: { kind: "renderer", reason: `the page's process ended: ${details.reason}` } });
				return;
			}
			if (this.#address !== null) void contents.loadURL(this.#address).catch((error: Error) => this.#d.log({ event: "gui-load-failed", detail: error.message.slice(0, 200) }));
		});
	}

	#external(url: string, via: "navigate" | "window-open"): void {
		const decision = externalLink(url, guiPortOf(this.#address));
		if (!decision.open) {
			this.#d.log({ event: "external-link", via, opened: false, reason: decision.reason });
			return;
		}
		this.#d.log({ event: "external-link", via, opened: true });
		void Promise.resolve(shell.openExternal(decision.href)).catch((error: Error) => this.#d.log({ event: "external-link-failed", detail: error.message.slice(0, 200) }));
	}

	#guardShell(shellView: WebContentsView): void {
		// The shell view shows packaged pages only: it is loaded by `loadFile` and never navigates, and it opens nothing.
		shellView.webContents.on("will-navigate", (event) => event.preventDefault());
		shellView.webContents.on("will-redirect", (event) => event.preventDefault());
		shellView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	}

	/** Camera for the GUI origin only (Straw Link's QR join); every other permission, and every other origin, is denied. */
	#restrictPermissions(): void {
		const ses = session.defaultSession;
		ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
			const types = (details as { mediaTypes?: string[] }).mediaTypes;
			callback(permissionAllowed(permission, details.requestingUrl, types, this.#origin));
		});
		ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
			const type = (details as { mediaType?: string }).mediaType;
			return permissionAllowed(permission, requestingOrigin, type === undefined ? undefined : [type], this.#origin);
		});
	}

	// ---- IPC: the page may ask only through these, and each checks who asks ------------------------------------------------

	/** The frame that sent `event` is the main frame of the GUI view, at the GUI's origin. */
	#fromGui(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
		const frame = this.#mainFrameOf(event, this.#gui);
		return frame !== null && isGuiUrl(frame.url, this.#origin);
	}

	/** The frame that sent `event` is the main frame of the shell view, showing a packaged page. */
	#fromShell(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
		const frame = this.#mainFrameOf(event, this.#shell);
		return frame !== null && frame.url.startsWith("file:");
	}

	#mainFrameOf(event: IpcMainEvent | IpcMainInvokeEvent, view: WebContentsView | undefined): { url: string } | null {
		const frame = event.senderFrame;
		if (view === undefined || frame === null || frame === undefined || event.sender !== view.webContents) return null;
		const main = view.webContents.mainFrame;
		return frame.processId === main.processId && frame.routingId === main.routingId ? frame : null;
	}

	#registerIpc(): void {
		// The preload asks synchronously, once, before the page runs: the GUI's origin when the asker is the GUI view's page, else null (no hook).
		ipcMain.on(CHANNELS.guiOrigin, (event) => {
			event.returnValue = this.#fromGui(event) ? this.#origin : null;
		});
		ipcMain.handle(CHANNELS.pickFolder, async (event, options: unknown) => {
			if (!this.#fromGui(event)) throw new Error("pickFolder is for the GUI page only");
			const window = this.#window;
			if (window === undefined || window.isDestroyed()) throw new Error("no window");
			const title = dialogTitle((options as { title?: unknown } | null)?.title);
			// The dialog opens in the work folder whatever the page asks for; a folder outside the home is still refused by the page (desk-mode decision D7).
			const picked = await dialog.showOpenDialog(window, { ...(title !== undefined ? { title } : {}), defaultPath: this.#d.workFolder(), properties: ["openDirectory", "createDirectory"] });
			return picked.canceled || picked.filePaths.length === 0 ? null : (picked.filePaths[0] ?? null);
		});
		ipcMain.handle(CHANNELS.state, (event): ShellState => {
			if (!this.#fromShell(event)) throw new Error("the state is for the shell page only");
			return this.#effective();
		});
		ipcMain.on(CHANNELS.action, (event, action: unknown) => {
			if (!this.#fromShell(event)) return;
			if (action === "retry" || action === "repair") {
				this.#d.onAction(action);
				return;
			}
			if (typeof action !== "object" || action === null) return;
			const a = action as { type?: unknown; id?: unknown; section?: unknown; height?: unknown };
			if (a.type === "dismiss-notice" && a.id === "wsl") {
				this.setNotices(this.#notices.filter((n) => n.id !== "wsl"));
			} else if (a.type === "open-settings" && (SETTINGS_SECTIONS as readonly unknown[]).includes(a.section)) {
				this.openSettings(a.section as SettingsSection);
			} else if (a.type === "update-restart") {
				void this.#d.onUpdateAction({ type: "update-restart" });
			} else if (a.type === "strip-height" && typeof a.height === "number" && Number.isFinite(a.height)) {
				// The page measures its own rows; the window clamps the answer so a page cannot take the GUI's room.
				const height = Math.min(Math.max(Math.round(a.height), BANNER_HEIGHT), MAX_STRIP_HEIGHT);
				if (height !== this.#stripHeight) {
					this.#stripHeight = height;
					this.#layout();
				}
			}
		});
		ipcMain.handle(CHANNELS.locale, (event): Locale => {
			if (!this.#fromShell(event)) throw new Error("the language is for the shell page only");
			return this.#locale;
		});
		ipcMain.handle(CHANNELS.wizardState, (event): WizardView => {
			if (!this.#fromShell(event)) throw new Error("the wizard state is for the shell page only");
			return this.#d.wizardView();
		});
		ipcMain.handle(CHANNELS.wizardAct, async (event, action: unknown): Promise<void> => {
			if (!this.#fromShell(event) || typeof action !== "object" || action === null || typeof (action as { type?: unknown }).type !== "string") return;
			await this.#d.onWizardAction(action as WizardAction);
		});
		ipcMain.handle(CHANNELS.settingsState, (event): SettingsView => {
			if (!this.#fromShell(event)) throw new Error("the settings state is for the shell page only");
			return this.#d.settingsView(this.#section);
		});
		ipcMain.handle(CHANNELS.settingsAct, async (event, action: unknown): Promise<void> => {
			if (!this.#fromShell(event) || typeof action !== "object" || action === null) return;
			const a = action as SettingsAction;
			if (a.type === "close") this.closeSettings();
			else if (a.type === "section" && (SETTINGS_SECTIONS as readonly unknown[]).includes(a.section)) this.openSettings(a.section);
			else if (a.type === "set-locale" && (a.locale === "en" || a.locale === "zh-TW")) await this.#d.onWizardAction({ type: "set-locale", locale: a.locale });
			else if (isAccountAction(a)) await this.#d.onAccountAction(a);
			else if (isUpdateAction(a)) await this.#d.onUpdateAction(a);
			else if (isRecipeAction(a)) await this.#d.onRecipeAction(a);
			else if (isComputerAction(a)) await this.#d.onComputerAction(a);
			else if (isDiagnosticsAction(a)) await this.#d.onDiagnosticsAction(a);
		});
	}
}
