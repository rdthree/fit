import { arrayBufferToBase64 } from "obsidian"
import {Fit, OctokitHttpError} from "./fit"
import { ClashStatus, ConflictReport, ConflictResolutionResult, FileOpRecord, LocalChange, LocalUpdate, RemoteChange, RemoteUpdate } from "./fitTypes"
import { RECOGNIZED_BINARY_EXT, extractExtension, removeLineEndingsFromBase64String, throttleAll, showFileOpsRecord, showUnappliedConflicts } from "./utils" // Make sure utils are imported 
import { FitPull } from "./fitPull"
import { FitPush } from "./fitPush"
import { VaultOperations } from "./vaultOps"
import { LocalStores } from "main"
import FitNotice from "./fitNotice"

export interface IFitSync {
    fit: Fit
}

type PreSyncCheckResult =  {
    status: "inSync"
} | {
    status: Exclude<PreSyncCheckResultType, "inSync">
    remoteUpdate: RemoteUpdate
    localChanges: LocalChange[]
    localTreeSha: Record<string, string>
}

type PreSyncCheckResultType = (
    "inSync" | 
    "onlyLocalChanged" | 
    "onlyRemoteChanged" | 
    "onlyRemoteCommitShaChanged" |
    "localAndRemoteChangesCompatible" | 
    "localAndRemoteChangesClashed"
)

export class FitSync implements IFitSync {
	fit: Fit;
	fitPull: FitPull;
	fitPush: FitPush;
	vaultOps: VaultOperations;
	saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>;
	plugin: any; // Replace 'any' with your actual plugin type


	constructor(fit: Fit, vaultOps: VaultOperations, saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>, plugin: any) { // Replace 'any' with your actual plugin type
        this.fit = fit
        this.fitPull = new FitPull(fit)
        this.fitPush = new FitPush(fit)
        this.vaultOps = vaultOps
		this.saveLocalStoreCallback = saveLocalStoreCallback;
		this.plugin = plugin;
    }

// --- Ensure blob cache is cleared before sync ---
	private async performSyncOperation<T>(syncNotice: FitNotice, operation: () => Promise<T>): Promise<T> {
		this.fit.clearBlobCache(); // Clear cache at the start
		syncNotice.show("Starting sync...", [], 0); // Show initial notice immediately
		try {
			const result = await operation();
			// Notice message updated within the operation or at the end
			return result;
		} catch (error) {
			console.error("Fit Sync Error:", error);
			let message = "Sync failed.";
			if (error instanceof OctokitHttpError) {
				message = `Sync failed: GitHub API Error (${error.status}) - ${error.message}. Source: ${error.source}`;
				if (error.status === 403) {
					message += " Check PAT permissions or rate limits.";
				} else if (error.status === 404) {
					message += " Check repo or branch name.";
				}
			} else if (error instanceof Error) {
				message = `Sync failed: ${error.message}`;
			}
			// Display error prominently, overriding muted state potentially
			syncNotice.setMessage(message, true); // Use error display
			syncNotice.remove("error", 10000); // Keep error visible longer
			throw error; // Re-throw to stop further processing if needed
		} finally {
			this.fit.clearBlobCache(); // Clear cache at the end too (optional, good practice)
		}
	}

	async performPreSyncChecks(syncNotice: FitNotice): Promise<PreSyncCheckResult> {
		syncNotice.setMessage("Checking local changes...");
		const currentLocalSha = await this.fit.computeLocalSha()
		const localChanges = await this.fit.getLocalChanges(currentLocalSha)

		syncNotice.setMessage("Checking remote status...");
		const {remoteCommitSha, updated: remoteUpdated} = await this.fit.remoteUpdated();
		if (localChanges.length === 0 && !remoteUpdated) {
			return {status: "inSync"}
		}

		syncNotice.setMessage("Fetching remote tree...");
		const remoteTreeSha = await this.fit.getRemoteTreeSha(remoteCommitSha)
		const remoteChanges = await this.fit.getRemoteChanges(remoteTreeSha)
		let clashes: ClashStatus[] = [];
		let status: PreSyncCheckResultType
		
        if (localChanges.length > 0 && !remoteUpdated) {
            status = "onlyLocalChanged"
        } else if (remoteUpdated && localChanges.length === 0 && remoteChanges.length === 0) {
            status = "onlyRemoteCommitShaChanged"
        } else if (localChanges.length === 0 && remoteUpdated) {
            status = "onlyRemoteChanged"
        } else {
            clashes = this.fit.getClashedChanges(localChanges, remoteChanges)
            if (clashes.length === 0) {
                status = "localAndRemoteChangesCompatible"
            } else {
                status =  "localAndRemoteChangesClashed"
            }    
        }
        return {
            status, 
            remoteUpdate: {
                remoteChanges, 
                remoteTreeSha, 
                latestRemoteCommitSha: remoteCommitSha, 
                clashedFiles: clashes
            }, 
            localChanges, 
            localTreeSha: currentLocalSha
        }
    }

	generateConflictReport(path: string, localContentBase64: string, remoteContentBase64: string): ConflictReport {
		// Needs base64 content now
		const detectedExtension = extractExtension(path)
		if (detectedExtension && RECOGNIZED_BINARY_EXT.includes(detectedExtension)) {
			return {
				path,
				resolutionStrategy: "binary",
				// Assuming remoteContentBase64 is already base64
				remoteContent: remoteContentBase64
			}
		}
		// For text, we might want to decode from base64 if needed by handlers,
		// but let's keep passing base64 for consistency with binary.
		// Handlers will need to decode if they expect utf-8 strings.
		return {
			path,
			resolutionStrategy: "utf-8", // Handler needs to decode base64
			localContent: localContentBase64,
			remoteContent: remoteContentBase64,
		}
	}

	// --- Handlers now receive base64 content ---
	async handleBinaryConflict(path: string, remoteContentBase64: string): Promise<FileOpRecord> {
		const conflictResolutionFolder = "_fit"
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`
		await this.fit.vaultOps.ensureFolderExists(conflictResolutionPath)
		// writeToLocal expects base64 content now
		await this.fit.vaultOps.writeToLocal(conflictResolutionPath, remoteContentBase64)
		return { path: conflictResolutionPath, status: "created" }
	}

	async handleUTF8Conflict(path: string, localContentBase64: string, remoteContentBase64: string): Promise<FileOpRecord> {
		// writeToLocal expects base64 content
		const conflictResolutionFolder = "_fit"
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`
		await this.fit.vaultOps.ensureFolderExists(conflictResolutionPath)
		await this.fit.vaultOps.writeToLocal(conflictResolutionPath, remoteContentBase64) // Write remote version
		// Optionally create a version with merge markers if desired, requires decoding base64 first
		return { path: conflictResolutionPath, status: "created" }
	}

	async handleLocalDeletionConflict(path: string, remoteContentBase64: string): Promise<FileOpRecord> {
		// writeToLocal expects base64 content
		const conflictResolutionFolder = "_fit"
		await this.fit.vaultOps.ensureFolderExists(conflictResolutionFolder) // Ensure base folder exists
		const conflictResolutionPath = `${conflictResolutionFolder}/${path}`
		await this.fit.vaultOps.ensureFolderExists(conflictResolutionPath) // Ensure specific file's folder exists
		await this.fit.vaultOps.writeToLocal(conflictResolutionPath, remoteContentBase64)
		return { path: conflictResolutionPath, status: "created" }
	}

	// --- MODIFIED: resolveFileConflict - Now uses blob content passed in ---
	// It no longer fetches blobs itself. It receives remoteContentBase64.
	async resolveFileConflict(
		clash: ClashStatus,
		remoteContentBase64: string | null // Pass content (base64) or null if remote deleted/not fetched
	): Promise<ConflictResolutionResult> {
		if (clash.localStatus === "deleted" && clash.remoteStatus === "REMOVED") {
			return {path: clash.path, noDiff: true}
		} else if (clash.localStatus === "deleted") {
			// Remote content exists (modified or added remotely) but local deleted
			if (remoteContentBase64 !== null) {
				const fileOp = await this.handleLocalDeletionConflict(clash.path, remoteContentBase64);
				return {path: clash.path, noDiff: false, fileOp: fileOp};
			} else {
				// Should not happen if remoteStatus is not REMOVED, but handle defensively
				console.warn(`Conflict Resolution: Local deleted ${clash.path}, but no remote content provided despite remote status ${clash.remoteStatus}`);
				return { path: clash.path, noDiff: true }; // Treat as no-op if remote content missing unexpectedly
			}
		}

		// Local file exists (created or changed)
		const localFile = await this.fit.vaultOps.getTFile(clash.path);
		const localFileContentArrBuf = await this.fit.vaultOps.vault.readBinary(localFile);
		const localFileContentBase64 = Buffer.from(localFileContentArrBuf).toString('base64'); // Use Buffer

		if (remoteContentBase64 !== null) {
			// Compare base64 content, removing line endings for text comparison robustness
			// Note: This comparison might be brittle for binary. Exact base64 comparison is safer there.
			// For text, canonicalizing line endings *before* base64 encoding would be ideal.
			const remoteCleaned = removeLineEndingsFromBase64String(remoteContentBase64);
			const localCleaned = removeLineEndingsFromBase64String(localFileContentBase64);

			if (remoteCleaned !== localCleaned) {
				const report = this.generateConflictReport(clash.path, localFileContentBase64, remoteContentBase64);
				let fileOp: FileOpRecord;
				if (report.resolutionStrategy === "binary") {
					fileOp = await this.handleBinaryConflict(clash.path, report.remoteContent); // Pass base64
				} else {
					// handleUTF8Conflict expects base64 now
					fileOp = await this.handleUTF8Conflict(clash.path, report.localContent, report.remoteContent);
				}
				return {path: clash.path, noDiff: false, fileOp: fileOp};
			}
			// Contents are effectively the same after cleaning line endings
			return { path: clash.path, noDiff: true };
		} else {
			// Remote file is deleted (remoteStatus === "REMOVED") but local file exists
			// This is a conflict: local change/creation vs remote deletion.
			// Current behavior: Keep local change, do nothing with remote deletion.
			// No fileOp needed as we are keeping the local version.
			console.log(`Conflict Resolution: Local ${clash.localStatus} ${clash.path} vs Remote REMOVED. Keeping local version.`);
			return { path: clash.path, noDiff: false }; // Indicate conflict occurred, but no local file op generated by resolution here.
		}
	}

	// --- MODIFIED: resolveConflicts - Batch fetch blobs first ---
	async resolveConflicts(
		clashedFiles: Array<ClashStatus>,
		latestRemoteTreeSha: Record<string, string>, // Map of path -> sha
		syncNotice: FitNotice)
		: Promise<{noConflict: boolean, unresolvedFiles: ClashStatus[], fileOpsRecord: FileOpRecord[]}> {

		syncNotice.setMessage("Resolving conflicts: Fetching remote file versions...");

		// 1. Collect unique SHAs needed for existing remote files involved in conflicts
		const remoteSHAsToFetch = new Set<string>();
		clashedFiles.forEach(clash => {
			// Fetch remote content if remote wasn't deleted and local wasn't deleted (or if local deleted but remote modified)
			if (clash.remoteStatus !== "REMOVED" && latestRemoteTreeSha[clash.path]) {
				remoteSHAsToFetch.add(latestRemoteTreeSha[clash.path]);
			}
			// No need to fetch if remote was REMOVED.
			// If local deleted and remote modified, we fetch above.
			// If local deleted and remote added, we fetch above.
		});

		// 2. Batch fetch using GraphQL getBlobs (populates cache in Fit)
		let remoteContents: { [sha: string]: string } = {};
		if (remoteSHAsToFetch.size > 0) {
			remoteContents = await this.fit.getBlobs(Array.from(remoteSHAsToFetch));
		}
		syncNotice.setMessage("Resolving conflicts: Comparing file versions...");


		// 3. Throttle the local processing of each conflict
		// throttleAll now controls local file reads and conflict logic execution concurrency
		const fileResolutions = await throttleAll(
			clashedFiles,
			4, // Concurrency limit for local processing (adjust as needed)
			async (clash): Promise<ConflictResolutionResult> => {
				const remoteSha = latestRemoteTreeSha[clash.path];
				// Get content from the prefetched map, or null if SHA wasn't fetched (e.g., remote REMOVED)
				const remoteContentBase64 = remoteSha ? (remoteContents[remoteSha] ?? null) : null;
				// Pass the fetched content (or null) to the resolver
				return this.resolveFileConflict(clash, remoteContentBase64);
			}
		);

		const unresolvedFiles = fileResolutions.map((res, i)=> {
			if (!res.noDiff) {
				return clashedFiles[i]
			}
			return null
		}).filter(Boolean) as Array<ClashStatus>
		return {
			noConflict: fileResolutions.every(res=>res.noDiff),
			unresolvedFiles,
			fileOpsRecord: fileResolutions.map(r => r.fileOp).filter(Boolean) as FileOpRecord[]
		}
	}

	async syncCompatibleChanges(
		localUpdate: LocalUpdate,
		remoteUpdate: RemoteUpdate,
		syncNotice: FitNotice): Promise<{localOps: FileOpRecord[], remoteOps: LocalChange[]}> { // Return type adjusted
		// Pull needs remote content
		syncNotice.setMessage("Preparing remote changes...");
		const {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(
			remoteUpdate.remoteChanges) // Uses getBlobs internally

		syncNotice.setMessage("Uploading local changes...");
		// Push needs remote tree structure, but not necessarily content unless checking for no-ops
		const remoteTreeForPush = await this.fit.getTree(localUpdate.parentCommitSha) // Get base tree structure
		const createCommitResult = await this.fitPush.createCommitFromLocalUpdate(localUpdate, remoteTreeForPush) // Uses createBlob internally

		let latestRemoteTreeShaMap: Record<string, string>; // Map path->sha
		let latestCommitSha: string;
		let pushedChanges: Array<LocalChange>;

		if (createCommitResult) {
			const {createdCommitSha} = createCommitResult
			syncNotice.setMessage("Updating remote reference...");
			const latestRefSha = await this.fit.updateRef(createdCommitSha) // This is the commit SHA, need tree SHA from it
			const commitTreeSha = await this.fit.getCommitTreeSha(latestRefSha); // Get tree SHA of the new commit
			latestRemoteTreeShaMap = await this.fit.getRemoteTreeSha(commitTreeSha); // Get the path->sha map for the new tree
			latestCommitSha = latestRefSha // This is correct, it's the commit SHA
			pushedChanges = createCommitResult.pushedChanges
		} else {
			// No local changes were pushed
			syncNotice.setMessage("No local changes needed uploading.");
			latestRemoteTreeShaMap = remoteUpdate.remoteTreeSha
			latestCommitSha = remoteUpdate.latestRemoteCommitSha
			pushedChanges = []
		}

		syncNotice.setMessage("Applying remote changes locally...");
		const localFileOpsRecord = await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal)

		syncNotice.setMessage("Updating local sync state...");
		// Need to compute new local SHAs *after* applying remote changes
		const newLocalSha = await this.fit.computeLocalSha();
		await this.saveLocalStoreCallback({
			lastFetchedRemoteSha: latestRemoteTreeShaMap,
			lastFetchedCommitSha: latestCommitSha,
			localSha: newLocalSha // Use the newly computed local SHAs
		})

		// syncNotice.setMessage("Sync successful"); // Set final message later in sync()
		// Return structure changed slightly to match usage
		return {localOps: localFileOpsRecord, remoteOps: pushedChanges}
	}


	async syncWithConflicts(
		localChanges: LocalChange[],
		remoteUpdate: RemoteUpdate,
		syncNotice: FitNotice) : Promise<{unresolvedFiles: ClashStatus[], localOps: FileOpRecord[], remoteOps: LocalChange[]} | null> { // Return type adjusted

		const {latestRemoteCommitSha, clashedFiles, remoteTreeSha: latestRemoteTreeShaMap} = remoteUpdate // Renamed for clarity

		// Resolve conflicts (this now batch fetches blobs)
		const {noConflict, unresolvedFiles, fileOpsRecord: conflictFileOps} = await this.resolveConflicts(
			clashedFiles, latestRemoteTreeShaMap, syncNotice);

		let localChangesToPush: Array<LocalChange>;
		let remoteChangesToWrite: Array<RemoteChange>

		if (noConflict) {
			syncNotice.setMessage("No file content conflicts found. Syncing distinct changes...");
			// Sync changes that didn't touch the same files
			remoteChangesToWrite = remoteUpdate.remoteChanges.filter(c => !localChanges.some(l => l.path === c.path))
			localChangesToPush = localChanges.filter(c => !remoteUpdate.remoteChanges.some(r => r.path === c.path))
		} else {
			syncNotice.setMessage(`Change conflicts detected. Check _fit folder. Syncing non-conflicting changes...`);
			// Filter out unresolved files from remote changes to apply locally
			remoteChangesToWrite = remoteUpdate.remoteChanges.filter(c => !unresolvedFiles.some(u => u.path === c.path))
			// Push all local changes (even conflicted ones) so remote has the user's latest attempt.
			// User resolves by editing local file and syncing again.
			localChangesToPush = localChanges
		}

		// Prepare remote changes for local application (fetches content via getBlobs)
		syncNotice.setMessage("Preparing remote changes...");
		const {addToLocal, deleteFromLocal} = await this.fitPull.prepareChangesToExecute(remoteChangesToWrite);

		// Prepare local changes for push
		const syncLocalUpdate: LocalUpdate = {
			localChanges: localChangesToPush,
			parentCommitSha: latestRemoteCommitSha // Base commit for push
		};

		// Push local changes (uses createBlob internally, gets throttled)
		syncNotice.setMessage("Uploading local changes...");
		const pushResult = await this.fitPush.pushChangedFilesToRemote(syncLocalUpdate);

		let pushedChanges: LocalChange[];
		let finalCommitSha: string;
		let finalRemoteTreeShaMap: Record<string, string>;

		if (pushResult) {
			pushedChanges = pushResult.pushedChanges;
			finalCommitSha = pushResult.lastFetchedCommitSha; // Commit SHA from push
			finalRemoteTreeShaMap = pushResult.lastFetchedRemoteSha; // Tree map from push
		} else {
			syncNotice.setMessage("No local changes needed uploading.");
			// If push didn't happen, the remote state is still the one we started with
			pushedChanges = [];
			finalCommitSha = remoteUpdate.latestRemoteCommitSha;
			finalRemoteTreeShaMap = remoteUpdate.remoteTreeSha;
		}

		// Apply prepared remote changes locally
		syncNotice.setMessage("Applying remote changes locally...");
		const localFileOpsRecord = await this.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal);

		// Combine file ops from conflict resolution and remote changes application
		const allLocalOps = localFileOpsRecord.concat(conflictFileOps);

		// Update local store
		syncNotice.setMessage("Updating local sync state...");
		const newLocalSha = await this.fit.computeLocalSha(); // Compute after all local changes
		await this.saveLocalStoreCallback({
			lastFetchedRemoteSha: finalRemoteTreeShaMap,
			lastFetchedCommitSha: finalCommitSha,
			localSha: newLocalSha
		});

		// Set final status message later in sync()
		return {unresolvedFiles, localOps: allLocalOps, remoteOps: pushedChanges};
	}

	// --- MODIFIED: Main sync entry point - wraps the operation ---
	async sync(syncNotice: FitNotice): Promise<{ops: Array<{heading: string, ops: FileOpRecord[]}>, clash: ClashStatus[]} | void> {
		return this.performSyncOperation(syncNotice, async () => {
			syncNotice.setMessage("Performing pre-sync checks.");
			const preSyncCheckResult = await this.performPreSyncChecks(syncNotice) // Methods inside are throttled

			let resultOps: Array<{heading: string, ops: FileOpRecord[]}> = [];
			let resultClash: ClashStatus[] = [];
			let finalMessage = "Sync successful"; // Default success message

			switch (preSyncCheckResult.status) {
				case "inSync":
					finalMessage = "Vault is already in sync.";
					break; // Nothing to do

				case "onlyRemoteCommitShaChanged":
					// Only need to update the stored commit SHA
					syncNotice.setMessage("Updating remote commit reference...");
					const { latestRemoteCommitSha } = preSyncCheckResult.remoteUpdate;
					await this.saveLocalStoreCallback({lastFetchedCommitSha: latestRemoteCommitSha});
					finalMessage = "Sync successful: Updated remote commit reference.";
					break;

				case "onlyRemoteChanged":
					syncNotice.setMessage("Pulling remote changes...");
					const pullOps = await this.fitPull.pullRemoteToLocal(
						preSyncCheckResult.remoteUpdate,
						this.saveLocalStoreCallback
					);
					resultOps = [{heading: "Local file updates (from remote):", ops: pullOps}];
					finalMessage = "Sync successful: Pulled remote changes.";
					break;

				case "onlyLocalChanged":
					syncNotice.setMessage("Pushing local changes...");
					const localUpdatePush: LocalUpdate = {
						localChanges: preSyncCheckResult.localChanges,
						parentCommitSha: preSyncCheckResult.remoteUpdate.latestRemoteCommitSha
					};
					const pushResult = await this.fitPush.pushChangedFilesToRemote(localUpdatePush);
					if (pushResult) {
						await this.saveLocalStoreCallback({
							localSha: preSyncCheckResult.localTreeSha, // The SHA *before* push
							lastFetchedRemoteSha: pushResult.lastFetchedRemoteSha,
							lastFetchedCommitSha: pushResult.lastFetchedCommitSha
						});
						// Note: pushChangedFilesToRemote returns LocalChange[], map to FileOpRecord[] if needed by UI
						const pushOpsMapped = pushResult.pushedChanges.map(c => ({ path: c.path, status: c.status } as FileOpRecord));
						resultOps = [{heading: "Remote file updates (from local):", ops: pushOpsMapped}];
						finalMessage = "Sync successful: Pushed local changes.";
					} else {
						// If pushResult is null, it means no actual changes needed pushing after checking base tree
						await this.saveLocalStoreCallback({
							localSha: preSyncCheckResult.localTreeSha,
							// Update commit SHA even if no files pushed, to match remote head we based off
							lastFetchedCommitSha: preSyncCheckResult.remoteUpdate.latestRemoteCommitSha
						});
						finalMessage = "Sync successful: Local changes were already present on remote.";
					}
					break;

				case "localAndRemoteChangesCompatible":
					syncNotice.setMessage("Syncing compatible changes...");
					const compatibleResult = await this.syncCompatibleChanges(
						{ localChanges: preSyncCheckResult.localChanges, parentCommitSha: preSyncCheckResult.remoteUpdate.latestRemoteCommitSha },
						preSyncCheckResult.remoteUpdate,
						syncNotice
					);
					const remoteOpsMapped = compatibleResult.remoteOps.map(c => ({ path: c.path, status: c.status } as FileOpRecord));
					resultOps = [
						{heading: "Local file updates (from remote):", ops: compatibleResult.localOps},
						{heading: "Remote file updates (from local):", ops: remoteOpsMapped},
					];
					finalMessage = "Sync successful: Merged compatible changes.";
					break;

				case "localAndRemoteChangesClashed":
					syncNotice.setMessage("Syncing with conflicts...");
					const conflictResult = await this.syncWithConflicts(
						preSyncCheckResult.localChanges,
						preSyncCheckResult.remoteUpdate,
						syncNotice
					);
					if (conflictResult) {
						const remoteOpsConflictMapped = conflictResult.remoteOps.map(c => ({ path: c.path, status: c.status } as FileOpRecord));

						resultOps = [
							{heading: "Local file updates (incl. conflict resolution):", ops: conflictResult.localOps},
							{heading: "Remote file updates (from local):", ops: remoteOpsConflictMapped},
						];
						resultClash = conflictResult.unresolvedFiles;
						if (resultClash.length > 0) {
							finalMessage = "Sync complete with conflicts. Check _fit folder.";
						} else {
							finalMessage = "Sync successful: Conflicts resolved automatically.";
						}
					} else {
						// Should not happen if syncWithConflicts always returns something, but handle defensively
						finalMessage = "Sync finished, but conflict resolution produced no result.";
					}
					break;
			}

			// Display final status and results
			syncNotice.setMessage(finalMessage);
			if (resultOps.length > 0 && this.plugin.settings.notifyChanges) { // Check settings
				showFileOpsRecord(resultOps); // Use utility to display ops
			}
			if (resultClash.length > 0 && this.plugin.settings.notifyConflicts) { // Check settings
				showUnappliedConflicts(resultClash); // Use utility to display conflicts
			}

			// Determine final notice behavior (auto-hide or stay)
			const hasIssues = resultClash.length > 0;
			const hasChanges = resultOps.some(opSet => opSet.ops.length > 0);
			if (hasIssues) {
				syncNotice.remove(hasIssues ? "error" : "done", 15000); // Keep visible longer if conflicts
			} else if (hasChanges) {
				syncNotice.remove("done", 5000);
			} else {
				syncNotice.remove("done", 3000); // Shorter for "in sync"
			}


			// Return structure for potential internal use (e.g., logging)
			if (hasChanges || hasIssues) {
				return { ops: resultOps, clash: resultClash };
			}

		}); // End of performSyncOperation wrapper
	}
}
// Helper function to get FitPlugin settings (assuming FitSync has access to plugin instance or settings)
// This needs to be wired correctly in your main plugin file where FitSync is instantiated.
// Example placeholder:
FitSync.prototype.plugin = { settings: { notifyChanges: true, notifyConflicts: true } } as any; // TODO: Fix this wiring properly
