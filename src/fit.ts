import { LocalStores, FitSettings } from "main"
import { Octokit } from "@octokit/core"
import { RECOGNIZED_BINARY_EXT, compareSha, throttle } from "./utils"
import { VaultOperations } from "./vaultOps"
import { LocalChange, LocalFileStatus, RemoteChange, RemoteChangeType } from "./fitTypes"
import { arrayBufferToBase64 } from "obsidian"
import { Buffer } from 'buffer'; // Import Buffer for base64 conversion in getBlobs


export type TreeNode = {
    path: string, 
    mode: "100644" | "100755" | "040000" | "160000" | "120000" | undefined, 
    type: "commit" | "blob" | "tree" | undefined, 
    sha: string | null}

type OctokitCallMethods = {
    getUser: () => Promise<{owner: string, avatarUrl: string}>
    getRepos: () => Promise<string[]>
    getRef: (ref: string) => Promise<string>
    getTree: (tree_sha: string) => Promise<TreeNode[]>
    getCommitTreeSha: (ref: string) => Promise<string>
    getRemoteTreeSha: (tree_sha: string) => Promise<{[k:string]: string}>
    createBlob: (content: string, encoding: string) =>Promise<string>
    createTreeNodeFromFile: ({path, status, extension}: LocalChange, remoteTree: TreeNode[]) => Promise<TreeNode|null>
    createCommit: (treeSha: string, parentSha: string) =>Promise<string>
    updateRef: (sha: string, ref: string) => Promise<string>
    getBlob: (file_sha:string) =>Promise<string>
	getBranches: () => Promise<string[]>	
}

export interface IFit extends OctokitCallMethods{
    owner: string
    repo: string
    branch: string
    headers: {[k: string]: string}
    deviceName: string
    localSha: Record<string, string>
	lastFetchedCommitSha: string | null
	lastFetchedRemoteSha: Record<string, string>
    octokit: Octokit
    vaultOps: VaultOperations
    fileSha1: (path: string) => Promise<string>
	clearBlobCache: () => void; // Add method signature
}

// Define a custom HttpError class that extends Error
export class OctokitHttpError extends Error {
    status: number;
    source: keyof OctokitCallMethods

    constructor(message: string, status: number, source: keyof OctokitCallMethods) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.source = source
    }
}

export class Fit implements IFit {
    owner: string
    repo: string
    auth: string | undefined
    branch: string
    headers: {[k: string]: string}
    deviceName: string
    localSha: Record<string, string>
	lastFetchedCommitSha: string | null
	lastFetchedRemoteSha: Record<string, string>
    octokit: Octokit
    vaultOps: VaultOperations
	// --- NEW: Blob Cache ---
	private blobCache: Map<string, string>;
	// --- NEW: Throttling state ---
	private lastApiCallTimestamp: number = 0;
	private apiCallIntervalMs: number = 150; // Minimum interval between API calls (adjust as needed)

    constructor(setting: FitSettings, localStores: LocalStores, vaultOps: VaultOperations) {
        this.loadSettings(setting)
        this.loadLocalStore(localStores)
        this.vaultOps = vaultOps
		this.blobCache = new Map<string, string>(); // Initialize cache
        this.headers = {
            // Hack to disable caching which leads to inconsistency for
            // read after write https://github.com/octokit/octokit.js/issues/890
            "If-None-Match": '', 
            'X-GitHub-Api-Version': '2022-11-28'
        }
    }

	// --- NEW: Method to clear cache before operations ---
	clearBlobCache(): void {
		this.blobCache.clear();
		// console.log("Fit: Blob cache cleared."); // Optional logging
	}

	// --- NEW: Centralized API Request Throttler ---
	private async throttledRequest<T>(requestFn: () => Promise<T>): Promise<T> {
		const now = Date.now();
		const timeSinceLastCall = now - this.lastApiCallTimestamp;
		const delayNeeded = Math.max(0, this.apiCallIntervalMs - timeSinceLastCall);

		if (delayNeeded > 0) {
			// console.log(`Fit: Throttling API call by ${delayNeeded}ms`); // Optional logging
			await throttle(delayNeeded); // Use utility throttle/sleep function
		}

		this.lastApiCallTimestamp = Date.now(); // Update timestamp *before* the call
		try {
			return await requestFn();
		} catch (error) {
			// Update timestamp even on error to prevent immediate retry burst
			this.lastApiCallTimestamp = Date.now();
			throw error; // Re-throw the original error
		}
	}
	
    loadSettings(setting: FitSettings) {
        this.owner = setting.owner
        this.repo = setting.repo
        this.branch = setting.branch
        this.deviceName = setting.deviceName
        this.octokit = new Octokit({auth: setting.pat})
    }
    
    loadLocalStore(localStore: LocalStores) {
        this.localSha = localStore.localSha
        this.lastFetchedCommitSha = localStore.lastFetchedCommitSha
        this.lastFetchedRemoteSha = localStore.lastFetchedRemoteSha
    }
    
    async fileSha1(fileContent: string): Promise<string> {
        const enc = new TextEncoder();
        const hashBuf = await crypto.subtle.digest('SHA-1', enc.encode(fileContent))
        const hashArray = Array.from(new Uint8Array(hashBuf));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }

    async computeFileLocalSha(path: string): Promise<string> {
        // Note: only support TFile now, investigate need for supporting TFolder later on
        const file = await this.vaultOps.getTFile(path) 
		// compute sha1 based on path and file content
        let content: string;
        if (RECOGNIZED_BINARY_EXT.includes(file.extension)) {
            content = arrayBufferToBase64(await this.vaultOps.vault.readBinary(file))
        } else {
            content = await this.vaultOps.vault.read(file)
        }
		return await this.fileSha1(path + content)
	}

	async computeLocalSha(): Promise<{[k:string]:string}> {
		const paths = this.vaultOps.vault.getFiles().map(f=>{
            // ignore local files in the _fit/ directory
            return f.path.startsWith("_fit/") ? null : f.path
        }).filter(Boolean)
		return Object.fromEntries(
			await Promise.all(
				paths.map(async (p: string): Promise<[string, string]> =>{
					return [p, await this.computeFileLocalSha(p)]
				})
			)
		)
	}

	async remoteUpdated(): Promise<{remoteCommitSha: string, updated: boolean}> {
		const remoteCommitSha = await this.getLatestRemoteCommitSha() // Uses throttled getRef
		return {remoteCommitSha, updated: remoteCommitSha !== this.lastFetchedCommitSha}
	}

    async getLocalChanges(currentLocalSha?: Record<string, string>): Promise<LocalChange[]> {
        if (!currentLocalSha) {
            currentLocalSha = await this.computeLocalSha()
        }
        const localChanges = compareSha(currentLocalSha, this.localSha, "local")
        return localChanges
    }

    async getRemoteChanges(remoteTreeSha: {[k: string]: string}): Promise<RemoteChange[]> {
        const remoteChanges = compareSha(remoteTreeSha, this.lastFetchedRemoteSha, "remote")
        return remoteChanges
    }

    getClashedChanges(localChanges: LocalChange[], remoteChanges:RemoteChange[]): Array<{path: string, localStatus: LocalFileStatus, remoteStatus: RemoteChangeType}> {
        const localChangePaths = localChanges.map(c=>c.path)
        const remoteChangePaths = remoteChanges.map(c=>c.path)
        const clashedFiles = localChangePaths.map(
            (path, localIndex) => {
                const remoteIndex = remoteChangePaths.indexOf(path)
                if (remoteIndex !== -1) {
                    return {path, localIndex, remoteIndex}
                }
                return null
            }).filter(Boolean) as Array<{path: string, localIndex: number, remoteIndex:number}>
        return clashedFiles.map(
            ({path, localIndex, remoteIndex}) => {
                return {
                    path,
                    localStatus: localChanges[localIndex].status,
                    remoteStatus: remoteChanges[remoteIndex].status
                }
            })
    }

	// --- Apply Throttling to API Calls ---

	async getUser(): Promise<{owner: string, avatarUrl: string}> {
		return this.throttledRequest(async () => {
			try {
				const {data: response} = await this.octokit.request(
					`GET /user`, {
						headers: this.headers
					})
				return {owner: response.login, avatarUrl:response.avatar_url}
			} catch (error) {
				throw new OctokitHttpError(error.message, error.status, "getUser");
			}
		});
	}

	async getRepos(): Promise<string[]> {
		// This involves multiple requests in a loop, throttling applies to each page request
		const allRepos: string[] = [];
		let page = 1;
		const perPage = 100;

		try {
			let hasMorePages = true;
			while (hasMorePages) {
				const response = await this.throttledRequest(async () => {
					return this.octokit.request(
						`GET /user/repos`, {
							affiliation: "owner",
							headers: this.headers,
							per_page: perPage,
							page: page
						}
					);
				});
				allRepos.push(...response.data.map(r => r.name));
				if (response.data.length < perPage) {
					hasMorePages = false;
				}
				page++;
			}
			return allRepos;
		} catch (error) {
			throw new OctokitHttpError(error.message, error.status, "getRepos");
		}
	}

	async getBranches(): Promise<string[]> {
		return this.throttledRequest(async () => {
			try {
				const {data: response} = await this.octokit.request(
					`GET /repos/{owner}/{repo}/branches`,
					{
						owner: this.owner,
						repo: this.repo,
						headers: this.headers
					})
				return response.map(r => r.name)
			} catch (error) {
				throw new OctokitHttpError(error.message, error.status, "getBranches"); // Corrected source name
			}
		});
	}

	async getRef(ref: string): Promise<string> {
		return this.throttledRequest(async () => {
			try {
				const {data: response} = await this.octokit.request(
					`GET /repos/{owner}/{repo}/git/ref/{ref}`, {
						owner: this.owner,
						repo: this.repo,
						ref: ref,
						headers: this.headers
					})
				return response.object.sha
			} catch (error) {
				// Handle ref not found (404) gracefully if needed, e.g., return null
				if (error.status === 404) {
					console.warn(`Ref ${ref} not found in ${this.owner}/${this.repo}`);
					// Depending on context, you might want to return null or a specific indicator
				}
				throw new OctokitHttpError(error.message, error.status, "getRef");
			}
		});
	}

    // Get the sha of the latest commit in the default branch (set by user in setting)
	async getLatestRemoteCommitSha(ref = `heads/${this.branch}`): Promise<string> {
		return this.getRef(ref) // Already throttled via getRef
	}

	async getCommitTreeSha(ref: string): Promise<string> {
		return this.throttledRequest(async () => {
			const {data: commit} =  await this.octokit.request(
				`GET /repos/{owner}/{repo}/commits/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref,
					headers: this.headers
				})
			return commit.commit.tree.sha
		});
	}

	async getTree(tree_sha: string): Promise<TreeNode[]> {
		return this.throttledRequest(async () => {
			const { data: tree } =  await this.octokit.request(
				`GET /repos/{owner}/{repo}/git/trees/{tree_sha}`, {
					owner: this.owner,
					repo: this.repo,
					tree_sha,
					recursive: 'true', // Be mindful: recursive can be large!
					headers: this.headers
				})
			// Consider adding pagination or using compare API if trees get too large
			if (tree.truncated) {
				console.warn(`Fit: Fetched tree ${tree_sha} was truncated. Results may be incomplete. Consider using the compare API for large repos.`);
				// Potentially throw an error or notify the user more prominently
			}
			return tree.tree as TreeNode[]
		});
	}

    // get the remote tree sha in the format compatible with local store
    async getRemoteTreeSha(tree_sha: string): Promise<{[k:string]: string}> {
        const remoteTree = await this.getTree(tree_sha)
        const remoteSha = Object.fromEntries(remoteTree.map((node: TreeNode) : [string, string] | null=>{
            // currently ignoring directory changes, if you'd like to upload a new directory, 
            // a quick hack would be creating an empty file inside
            if (node.type=="blob") {
                if (!node.path || !node.sha) {
                    throw new Error("Path or sha not found for blob node in remote");
                }
                // ignore changes in the _fit/ directory
                if (node.path.startsWith("_fit/")) {return null}
                return [node.path, node.sha]
            }
            return null
        }).filter(Boolean) as [string, string][])
        return remoteSha
    }

	async createBlob(content: string, encoding: string): Promise<string> {
		return this.throttledRequest(async () => {
			const {data: blob} = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/blobs`, {
					owner: this.owner,
					repo: this.repo,
					content,
					encoding,
					headers: this.headers
				})
			return blob.sha
		});
	}


    async createTreeNodeFromFile({path, status, extension}: LocalChange, remoteTree: Array<TreeNode>): Promise<TreeNode|null> {
		if (status === "deleted") {
            // skip creating deletion node if file not found on remote
            if (remoteTree.every(node => node.path !== path)) {
                return null
            }
			return {
				path,
				mode: '100644',
				type: 'blob',
				sha: null
			}
		}
        const file = await this.vaultOps.getTFile(path)
		let encoding: string;
		let content: string 
        // TODO check whether every files including md can be read using readBinary to reduce code complexity
		if (extension && RECOGNIZED_BINARY_EXT.includes(extension)) {
			encoding = "base64"

			const fileArrayBuf = await this.vaultOps.vault.readBinary(file)
			const uint8Array = new Uint8Array(fileArrayBuf);
			let binaryString = '';
			for (let i = 0; i < uint8Array.length; i++) {
				binaryString += String.fromCharCode(uint8Array[i]);
			}
			// Use Buffer for reliable base64 encoding, especially in Node-like envs (Obsidian desktop)
			content = Buffer.from(fileArrayBuf).toString('base64');
		} else {
			encoding = 'utf-8'
			content = await this.vaultOps.vault.read(file)
		}
		const blobSha = await this.createBlob(content, encoding) // Throttled call
        // skip creating node if file found on remote is the same as the created blob
        if (remoteTree.some(node => node.path === path && node.sha === blobSha)) {
            return null
        }
		return {
			path: path,
			mode: '100644',
			type: 'blob',
			sha: blobSha,
		}
	}

	async createTree(treeNodes: Array<TreeNode>, base_tree_sha: string): Promise<string> {
		return this.throttledRequest(async () => {
			const {data: newTree} = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/trees`,
				{
					owner: this.owner,
					repo: this.repo,
					tree: treeNodes,
					base_tree: base_tree_sha,
					headers: this.headers
				}
			)
			return newTree.sha
		});
	}

	async createCommit(treeSha: string, parentSha: string): Promise<string> {
		return this.throttledRequest(async () => {
			const message = `Commit from ${this.deviceName} on ${new Date().toLocaleString()}`
			const { data: createdCommit } = await this.octokit.request(
				`POST /repos/{owner}/{repo}/git/commits` , {
					owner: this.owner,
					repo: this.repo,
					message,
					tree: treeSha,
					parents: [parentSha],
					headers: this.headers
				})
			return createdCommit.sha
		});
	}

	async updateRef(sha: string, ref = `heads/${this.branch}`): Promise<string> {
		return this.throttledRequest(async () => {
			const { data:updatedRef } = await this.octokit.request(
				`PATCH /repos/{owner}/{repo}/git/refs/{ref}`, {
					owner: this.owner,
					repo: this.repo,
					ref,
					sha,
					headers: this.headers
				})
			return updatedRef.object.sha
		});
	}

	// --- MODIFIED: getBlob - Use Cache First ---
	async getBlob(file_sha:string): Promise<string> {
		// 1. Check cache
		if (this.blobCache.has(file_sha)) {
			// console.log(`Fit: Cache hit for blob ${file_sha}`); // Optional logging
			return this.blobCache.get(file_sha) as string;
		}

		// 2. Fetch if not in cache (throttled)
		// console.log(`Fit: Cache miss for blob ${file_sha}, fetching...`); // Optional logging
		return this.throttledRequest(async () => {
			try {
				const { data: blob } = await this.octokit.request(
					`GET /repos/{owner}/{repo}/git/blobs/{file_sha}`, {
						owner: this.owner,
						repo: this.repo,
						file_sha,
						headers: this.headers
					});

				// 3. Store in cache BEFORE returning
				this.blobCache.set(file_sha, blob.content);
				return blob.content;
			} catch (error) {
				// Handle blob not found (404/422) gracefully if needed
				if (error.status === 404 || error.status === 422) {
					console.warn(`Blob ${file_sha} not found in ${this.owner}/${this.repo}`);
					// Return null or empty string, or rethrow depending on expected behavior
					return ""; // Example: return empty string
				}
				throw new OctokitHttpError(error.message, error.status, "getBlob");
			}
		});
	}

	// NEW FUNCTION: Bundled blob retrieval using GraphQL
	// --- MODIFIED: getBlobs (GraphQL) - Use and Populate Cache ---
// --- MODIFIED: getBlobs (GraphQL) - Added Batching for 100 ID Limit ---
	async getBlobs(blobSHAs: string[]): Promise<{ [sha: string]: string }> {
		// Filter out invalid SHAs early (e.g., empty strings or nulls if they somehow slip in)
		const validBlobSHAs = blobSHAs.filter(sha => sha && typeof sha === 'string' && sha.length > 0);

		const neededSHAs = validBlobSHAs.filter(sha => !this.blobCache.has(sha));
		const results: { [sha: string]: string } = {};

		// Populate results from cache first
		validBlobSHAs.forEach(sha => {
			if (this.blobCache.has(sha)) {
				results[sha] = this.blobCache.get(sha) as string;
			}
		});

		if (neededSHAs.length === 0) {
			// console.log("Fit: All blobs requested were already in cache.");
			return results;
		}

		console.log(`Fit: Need to fetch ${neededSHAs.length} blobs via GraphQL.`);

		// --- Batching Logic ---
		const BATCH_SIZE = 95; // Stay safely under the 100 limit
		for (let i = 0; i < neededSHAs.length; i += BATCH_SIZE) {
			const batchSHAs = neededSHAs.slice(i, i + BATCH_SIZE);
			console.log(`Fit: Fetching GraphQL batch ${Math.floor(i / BATCH_SIZE) + 1} with ${batchSHAs.length} IDs.`);

			// Convert batch SHAs to GraphQL node IDs
			const ids = batchSHAs.map(sha =>
				Buffer.from(`blob:${sha}`).toString('base64') // Assuming this format is correct
			);

			// Build the GraphQL query
			const query = `
            query ($ids: [ID!]!) {
                nodes(ids: $ids) {
                    ... on Blob {
                        oid # The SHA
                        # byteSize
                        text # Content for text files (may be null for binary)
                        isBinary
                    }
                }
            }`;
			const variables = { ids };

			try {
				// Call the GraphQL endpoint (throttled automatically by throttledRequest)
				const response: { nodes: Array<{ oid: string; text: string | null; isBinary: boolean } | null> } =
					await this.throttledRequest(() => this.octokit.graphql(query, variables));

				// Process results for this batch and update cache
				response.nodes.forEach(node => {
					if (node?.oid) {
						const content = node.text ?? ""; // Default to empty if text is null
						results[node.oid] = content;
						this.blobCache.set(node.oid, content);
						if (node.text === null) {
							console.warn(`Fit: GraphQL node for SHA ${node.oid} returned null text. Content might be binary or too large.`);
						}
					}
				});

				// Check for any SHAs in the *batch* that weren't returned
				batchSHAs.forEach(sha => {
					if (!(sha in results)) {
						// This might happen if the blob ID format was wrong, or the blob truly doesn't exist
						console.warn(`Fit: Blob SHA ${sha} from batch not found in GraphQL response.`);
						results[sha] = ""; // Mark as fetched but empty/not found
						this.blobCache.set(sha, "");
					}
				});

			} catch (error) {
				console.error(`Fit: GraphQL batch fetch failed (Batch starting index ${i}):`, error);
				// Mark all SHAs in this *failed batch* as empty in results and cache to avoid retrying them individually
				batchSHAs.forEach(sha => {
					if (!(sha in results)) { // Avoid overwriting if fetched in a previous successful batch (shouldn't happen with current logic but safe)
						results[sha] = "";
						this.blobCache.set(sha, "");
					}
				});
				// Decide whether to continue with other batches or rethrow the error to halt the sync
				// For robustness, let's log the error and continue, results will be incomplete
				// If halting is preferred, uncomment the next line:
				// throw new OctokitHttpError(`GraphQL batch fetch failed: ${error.message}`, error.status || 500, "getBlobs");
			}
		} // End of batch loop

		// Final check: Ensure all *originally* needed SHAs have *some* entry in results, even if fetch failed.
		neededSHAs.forEach(sha => {
			if (!(sha in results)) {
				console.warn(`Fit: Blob SHA ${sha} was needed but missing from final results (potential logic error?). Marking as empty.`);
				results[sha] = "";
				if (!this.blobCache.has(sha)) this.blobCache.set(sha, ""); // Cache the miss if not already cached by batch failure
			}
		});

		return results;
	}

} // End of Fit class
