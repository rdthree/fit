import { App, Notice, Plugin, PluginSettingTab, Setting, Vault } from 'obsidian';
import { Fit, OctokitHttpError } from 'src/fit'; // Import interfaces/classes from fit
import FitNotice from 'src/fitNotice';
import FitSettingTab from 'src/fitSetting';
import { FitSync } from 'src/fitSync';
import { showFileOpsRecord, showUnappliedConflicts } from 'src/utils';
import { VaultOperations } from 'src/vaultOps';

// Define interfaces clearly and separately
export interface FitSettings {
	pat: string;
	owner: string;
	avatarUrl: string;
	repo: string;
	branch: string;
	deviceName: string;
	checkEveryXMinutes: number;
	autoSync: "on" | "off" | "muted" | "remind";
	notifyChanges: boolean;
	notifyConflicts: boolean;
}

export interface LocalStores {
	localSha: Record<string, string>;
	lastFetchedCommitSha: string | null;
	lastFetchedRemoteSha: Record<string, string>;
}

// --- Default values ---
const DEFAULT_SETTINGS: FitSettings = {
	pat: "",
	owner: "",
	avatarUrl: "",
	repo: "",
	branch: "",
	deviceName: "Obsidian Fit Sync", // Default device name
	checkEveryXMinutes: 5,
	autoSync: "off",
	notifyChanges: true,
	notifyConflicts: true
};

const DEFAULT_LOCAL_STORE: LocalStores = {
	localSha: {},
	lastFetchedCommitSha: null,
	lastFetchedRemoteSha: {}
};

// Combined data structure ONLY for saving/loading
interface FitPluginData extends FitSettings, LocalStores {}

export default class FitPlugin extends Plugin {
	settings: FitSettings;
	localStore: LocalStores; // Separate store for local state
	settingTab: FitSettingTab;
	fit: Fit;
	vaultOps: VaultOperations;
	fitSync: FitSync;
	syncing: boolean = false;
	autoSyncing: boolean = false; // Separate flag for auto sync
	autoSyncIntervalId: number | null = null;
	fitSyncRibbonIconEl: HTMLElement; // Keep reference if needed

	async onload() {
		await this.loadPluginData(); // Load combined data first

		this.vaultOps = new VaultOperations(this.app.vault);
		// Instantiate Fit with separated settings and local store
		this.fit = new Fit(this.settings, this.localStore, this.vaultOps);
		// Instantiate FitSync, passing dependencies including the plugin instance ('this')
		this.fitSync = new FitSync(this.fit, this.vaultOps, this.saveLocalStoreData.bind(this), this);

		this.settingTab = new FitSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.loadRibbonIcons();
		this.addCommands();

		// Setup Auto Checker after everything is loaded
		this.setupAutoChecker();

		// Initial check if settings are configured on load
		this.checkSettingsConfigured(true); // Pass flag to indicate initial load check
	}

	onunload() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	// --- Data Loading and Saving ---

	// Loads combined data and populates settings and localStore
	async loadPluginData() {
		const loadedData = Object.assign({}, DEFAULT_SETTINGS, DEFAULT_LOCAL_STORE, await this.loadData());

		// Populate this.settings
		this.settings = Object.keys(DEFAULT_SETTINGS).reduce((obj, key: keyof FitSettings) => {
			// Ensure type safety and correct parsing
			if (loadedData.hasOwnProperty(key)) {
				if (key === "checkEveryXMinutes") {
					obj[key] = Number(loadedData[key]) || DEFAULT_SETTINGS.checkEveryXMinutes;
				} else if (key === "notifyChanges" || key === "notifyConflicts") {
					obj[key] = Boolean(loadedData[key]);
				} else if (key === "autoSync") {
					const val = loadedData[key];
					obj[key] = (val === "on" || val === "muted" || val === "remind") ? val : "off";
				} else {
					obj[key] = loadedData[key];
				}
			} else {
				// Assign default if key missing (shouldn't happen with Object.assign defaults)
				obj[key] = DEFAULT_SETTINGS[key] as never;
			}
			return obj;
		}, {} as FitSettings);

		// Populate this.localStore
		this.localStore = Object.keys(DEFAULT_LOCAL_STORE).reduce((obj, key: keyof LocalStores) => {
			if (loadedData.hasOwnProperty(key)) {
				// Handle potential null/undefined for sha maps gracefully
				if (key === "localSha" || key === "lastFetchedRemoteSha") {
					obj[key] = loadedData[key] ?? {};
				} else {
					obj[key] = loadedData[key] ?? null; // Handles lastFetchedCommitSha
				}
			} else {
				obj[key] = DEFAULT_LOCAL_STORE[key] as never;
			}
			return obj;
		}, {} as LocalStores);
	}

	// Saves only the local store part, combining with current settings
	async saveLocalStoreData(localStoreUpdate: Partial<LocalStores>): Promise<void> {
		// Update the in-memory local store first
		this.localStore = { ...this.localStore, ...localStoreUpdate };
		// Prepare combined data for saving
		const dataToSave: FitPluginData = { ...this.settings, ...this.localStore };
		await this.saveData(dataToSave);
		// Ensure Fit instance is aware of the update
		this.fit.loadLocalStore(this.localStore);
	}

	// Saves only the settings part, combining with current local store
	async saveSettings() {
		// Prepare combined data for saving
		const dataToSave: FitPluginData = { ...this.settings, ...this.localStore };
		await this.saveData(dataToSave);
		// Ensure Fit instance is aware of potential PAT/repo/branch changes
		this.fit.loadSettings(this.settings);
		// Restart auto-checker if interval/enabled status might have changed
		this.setupAutoChecker();
	}


	// --- Sync Logic ---

	// Main function to trigger a sync operation
	async triggerSync(muted: boolean, source: 'manual' | 'auto' = 'manual') {
		// Prevent concurrent syncs
		if (source === 'manual' && (this.syncing || this.autoSyncing)) {
			new Notice("Sync already in progress.");
			return;
		}
		if (source === 'auto' && (this.syncing || this.autoSyncing)) {
			console.log("Fit: Auto Sync skipped, another sync in progress.");
			return; // Don't show notice for auto-sync skip
		}

		if (!this.checkSettingsConfigured()) { return; } // Check settings before proceeding

		// Set appropriate flag
		if (source === 'manual') this.syncing = true;
		else this.autoSyncing = true;

		// Animate ribbon icon if it exists and source is manual
		if (source === 'manual' && this.fitSyncRibbonIconEl) {
			this.fitSyncRibbonIconEl.addClass('animate-icon');
		}

		// Create notice (muted state depends on call)
		const syncNotice = new FitNotice(this.fit, ["loading"], "Initiating sync", 0, muted);

		try {
			// Call the core sync logic in FitSync
			// FitSync's sync method now handles its internal errors and progress notices
			await this.fitSync.sync(syncNotice);

			// If sync completes without throwing, manage the final notice state
			// Determine if there were issues based on the return or notice state?
			// Assuming FitSync.sync handles the final message. We just need to remove the notice eventually.
			// Use the state logic from FitSync's sync method if possible, or a simpler timeout here.
			// Let's rely on FitSync setting the final message and use a standard timeout removal.
			syncNotice.remove("done", muted ? 1000 : 5000); // Shorter timeout if muted

		} catch (e) {
			// Catch errors re-thrown by FitSync.performSyncOperation
			// Error message should already be set on syncNotice by performSyncOperation
			console.error(`Fit: ${source} sync trigger failed:`, e);
			// Keep error notice visible longer
			syncNotice.remove("error", 15000);
			// No need for extra Notice here as syncNotice handles it
		} finally {
			// Clear appropriate flag
			if (source === 'manual') this.syncing = false;
			else this.autoSyncing = false;

			// Stop animation if manual sync
			if (source === 'manual' && this.fitSyncRibbonIconEl) {
				this.fitSyncRibbonIconEl.removeClass('animate-icon');
			}
		}
	}

	// --- Auto Sync ---
	setupAutoChecker() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}

		if (this.settings.autoSync !== "off" && this.settings.checkEveryXMinutes > 0) {
			console.log(`Fit: Scheduling auto-check every ${this.settings.checkEveryXMinutes} minutes.`);
			this.autoSyncIntervalId = window.setInterval(
				() => this.performAutoCheck(),
				this.settings.checkEveryXMinutes * 60 * 1000
			);
			this.registerInterval(this.autoSyncIntervalId); // Register for cleanup on unload
		} else {
			console.log("Fit: Auto-check disabled.");
		}
	}

	async performAutoCheck() {
		if (this.syncing || this.autoSyncing) {
			console.log("Fit: Auto-check skipped, sync in progress.");
			return;
		}
		if (!this.checkSettingsConfigured(true)) { // Check settings silently on auto-check
			console.log("Fit: Auto-check skipped, settings not configured.");
			return;
		}

		console.log("Fit: Performing auto-check...");
		try {
			// Use fit.remoteUpdated which is now throttled
			const { updated } = await this.fit.remoteUpdated();
			if (updated) {
				console.log("Fit: Remote updates detected during auto-check.");
				if (this.settings.autoSync === 'on' || this.settings.autoSync === 'muted') {
					await this.triggerSync(this.settings.autoSync === 'muted', 'auto');
				} else if (this.settings.autoSync === 'remind') {
					new Notice("Fit: Remote changes detected. Run manual sync.", 5000);
				}
			} else {
				console.log("Fit: No remote changes detected during auto-check.");
			}
		} catch (error) {
			// Log errors during auto-check, but don't necessarily notify user unless persistent
			console.error("Fit: Auto-check failed:", error);
			if (error instanceof OctokitHttpError && (error.status === 401 || error.status === 403 || error.status === 404)) {
				// Potentially disable auto-check or notify user after repeated critical failures
				console.warn("Fit: Auto-check failed due to authentication/permissions/not found error. Consider reviewing settings.");
			}
		}
	}

	// --- UI Setup ---

	loadRibbonIcons() {
		this.fitSyncRibbonIconEl = this.addRibbonIcon('github', 'Fit Sync', async (evt: MouseEvent) => {
			await this.triggerSync(false, 'manual'); // Manual sync, not muted
		});
		this.fitSyncRibbonIconEl.addClass('fit-sync-ribbon-el'); // Add class for potential styling
	}

	addCommands() {
		this.addCommand({
			id: 'fit-sync',
			name: 'Sync with remote',
			callback: async () => {
				await this.triggerSync(false, 'manual'); // Manual sync, not muted
			}
		});

		this.addCommand({
			id: 'fit-open-settings',
			name: 'Open Fit settings',
			callback: () => {
				this.openPluginSettings();
			}
		});
	}


	// --- Settings Check ---
	checkSettingsConfigured(silent = false): boolean {
		const actionItems: string[] = [];
		if (!this.settings.pat) actionItems.push("provide GitHub personal access token");
		if (!this.settings.owner) actionItems.push("authenticate with token (click 'Authenticate user')");
		if (!this.settings.repo) actionItems.push("select a repository");
		if (!this.settings.branch) actionItems.push("select a branch");

		if (actionItems.length > 0) {
			if (!silent) {
				const initialMessage = "Fit settings incomplete:\n- " + actionItems.join("\n- ");
				// Use Obsidian's Notice directly for settings issues
				new Notice(initialMessage, 10000); // Longer duration notice
				this.openPluginSettings();
			}
			return false;
		}
		// Settings seem okay, ensure Fit instance is updated (might be redundant if saveSettings does it)
		// this.fit.loadSettings(this.settings); // Ensure Fit has latest settings
		return true;
	}

	openPluginSettings() {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(this.app as any).setting?.open();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(this.app as any).setting?.openTabById("fit");
	}
}
