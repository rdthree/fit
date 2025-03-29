import { Fit } from "./fit";
import { LocalStores } from "main";
import { FileOpRecord, LocalChange, RemoteChange, RemoteUpdate } from "./fitTypes";
import { throttleAll } from "./utils";


type PrePullCheckResultType = (
    "localCopyUpToDate" | 
    "localChangesClashWithRemoteChanges" | 
    "remoteChangesCanBeMerged" | 
    "noRemoteChangesDetected"
)

type PrePullCheckResult = (
    { status: "localCopyUpToDate", remoteUpdate: null } | 
    { status: Exclude<PrePullCheckResultType, "localCopyUpToDate">, remoteUpdate: RemoteUpdate }
);

export interface IFitPull {
    fit: Fit
}

export class FitPull implements IFitPull {
    fit: Fit
    

    constructor(fit: Fit) {
        this.fit = fit
    }

    async performPrePullChecks(localChanges?: LocalChange[]): Promise<PrePullCheckResult> {
        const {remoteCommitSha, updated} = await this.fit.remoteUpdated()
        if (!updated) {
            return {status: "localCopyUpToDate", remoteUpdate: null}
        }
        if (!localChanges) {
            localChanges = await this.fit.getLocalChanges()
        }
        const remoteTreeSha = await this.fit.getRemoteTreeSha(remoteCommitSha)
        const remoteChanges = await this.fit.getRemoteChanges(remoteTreeSha)
        const clashedFiles = this.fit.getClashedChanges(localChanges, remoteChanges)
        // TODO handle clashes without completely blocking pull
        const prePullCheckStatus = (
            (remoteChanges.length > 0) ? (
                (clashedFiles.length > 0) ? "localChangesClashWithRemoteChanges" : "remoteChangesCanBeMerged"):
                "noRemoteChangesDetected")
        
        return {
            status: prePullCheckStatus, 
            remoteUpdate: {
                remoteChanges, remoteTreeSha, latestRemoteCommitSha: remoteCommitSha, clashedFiles
            }
        }
    }

    // Get changes from remote, pathShaMap is coupled to the Fit plugin design
	async getRemoteNonDeletionChangesContent(pathShaMap: Record<string, string>) {
		// Convert the object into an array of [path, file_sha] entries.
		const entries = Object.entries(pathShaMap);
		// Extract all blob SHAs.
		const blobSHAs = entries.map(([_, sha]) => sha);

		// Use the new getBlobs function to fetch all blobs at once.
		const blobs = await this.fit.getBlobs(blobSHAs);

		// Map back the results to an array of objects with path and content.
		return entries.map(([path, sha]) => ({
			path,
			content: blobs[sha] || ""
		}));
	}



	async prepareChangesToExecute(remoteChanges: RemoteChange[]) {
        const deleteFromLocal = remoteChanges.filter(c=>c.status=="REMOVED").map(c=>c.path)
			const changesToProcess = remoteChanges.filter(c=>c.status!="REMOVED").reduce(
				(acc, change) => {
                    acc[change.path] = change.currentSha as string;
					return acc;
                }, {} as Record<string, string>);

		const addToLocal = await this.getRemoteNonDeletionChangesContent(changesToProcess)
        return {addToLocal, deleteFromLocal}
    }

    async pullRemoteToLocal(
        remoteUpdate: RemoteUpdate,
        saveLocalStoreCallback: (localStore: Partial<LocalStores>) => Promise<void>): Promise<FileOpRecord[]> {
            const {remoteChanges, remoteTreeSha, latestRemoteCommitSha} = remoteUpdate
            const {addToLocal, deleteFromLocal} = await this.prepareChangesToExecute(remoteChanges)
			
			const fileOpsRecord = await this.fit.vaultOps.updateLocalFiles(addToLocal, deleteFromLocal);
			await saveLocalStoreCallback({
                lastFetchedRemoteSha: remoteTreeSha, 
                lastFetchedCommitSha: latestRemoteCommitSha,
                localSha: await this.fit.computeLocalSha()
            })
            return fileOpsRecord
    }
}
