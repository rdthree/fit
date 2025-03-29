import { TFile, Vault, base64ToArrayBuffer, TFolder, normalizePath } from "obsidian"; // Added TFolder, normalizePath
import { FileOpRecord } from "./fitTypes";
import { Buffer } from 'buffer'; // Use Buffer for robust encoding/decoding

export interface IVaultOperations {
    vault: Vault
    deleteFromLocal: (path: string) => Promise<FileOpRecord>
    writeToLocal: (path: string, content: string) => Promise<FileOpRecord>
    updateLocalFiles: (
        addToLocal: {path: string, content: string}[], deleteFromLocal: Array<string>) 
        => Promise<FileOpRecord[]>
    createCopyInDir: (path: string, copyDir: string) => Promise<void>
}

export class VaultOperations implements IVaultOperations {
    vault: Vault

    constructor(vault: Vault) {
        this.vault = vault
    }

    async getTFile(path: string): Promise<TFile> {
        const file = this.vault.getAbstractFileByPath(path)
        if (file && file instanceof TFile) {
            return file
        } else {
            throw new Error(`Attempting to read ${path} from local drive as TFile but not successful,
            file is of type ${typeof file}.`)
        }
    }

    async deleteFromLocal(path: string): Promise<FileOpRecord> {
        // adopted getAbstractFileByPath for mobile compatiability
        const file = this.vault.getAbstractFileByPath(path)
        if (file && file instanceof TFile) {
            await this.vault.delete(file);
            return {path, status: "deleted"}
        } 
        throw new Error(`Attempting to delete ${path} from local but not successful, file is of type ${typeof file}.`);
    }

    // if checking a folder, require including the last / in the path param
	// --- MODIFIED: ensureFolderExists - More robust error handling ---
	async ensureFolderExists(filePath: string): Promise<void> {
		const normalizedFilePath = normalizePath(filePath); // Normalize path first
		const lastSlash = normalizedFilePath.lastIndexOf('/');
		if (lastSlash > 0) {
			const folderPath = normalizedFilePath.substring(0, lastSlash);
			if (folderPath) {
				const existing = this.vault.getAbstractFileByPath(folderPath);

				if (!existing) {
					// Folder does not exist, try to create it
					console.log(`Fit: Creating folder: ${folderPath}`); // Log creation attempt
					try {
						await this.vault.createFolder(folderPath);
					} catch (e) {
						// Check if the error is specifically "Folder already exists"
						// This might happen due to a race condition or Obsidian internal state
						if (e.message?.includes("Folder already exists")) {
							console.warn(`Fit: Attempted to create folder '${folderPath}' but it already exists (Obsidian error ignored).`);
							// If it already exists, check if it's actually a folder
							const checkExisting = this.vault.getAbstractFileByPath(folderPath);
							if (!(checkExisting instanceof TFolder)) {
								const errorMsg = `Path '${folderPath}' exists but is not a folder (Type: ${checkExisting?.constructor.name}). Cannot proceed.`;
								console.error(`Fit: ${errorMsg}`);
								throw new Error(errorMsg); // Throw a specific error
							}
							// It exists and is a folder, so we're good.
						} else {
							// Re-throw unexpected errors during folder creation
							console.error(`Fit: Unexpected error creating folder '${folderPath}':`, e);
							throw e;
						}
					}
				} else if (!(existing instanceof TFolder)) {
					// Path exists but is not a folder
					const errorMsg = `Path '${folderPath}' exists but is not a folder (Type: ${existing?.constructor.name}). Cannot ensure folder.`;
					console.error(`Fit: ${errorMsg}`);
					throw new Error(errorMsg);
				}
				// else: Folder exists and is a TFolder, do nothing.
			}
		}
	}


	// --- writeToLocal - Ensure it calls the robust ensureFolderExists ---
	async writeToLocal(path: string, contentBase64: string): Promise<FileOpRecord> {
		const normalizedPath = normalizePath(path); // Normalize path
		let arrayBuffer: ArrayBuffer;
		try {
			arrayBuffer = base64ToArrayBuffer(contentBase64);
		} catch (e) {
			console.error(`Error decoding base64 for path: ${normalizedPath}`, e);
			throw new Error(`Invalid base64 content received for ${normalizedPath}`);
		}

		// Ensure folder exists *before* trying to access/create the file
		await this.ensureFolderExists(normalizedPath);

		const file = this.vault.getAbstractFileByPath(normalizedPath);
		try {
			if (file instanceof TFile) {
				await this.vault.modifyBinary(file, arrayBuffer);
				return {path: normalizedPath, status: "changed"};
			} else if (!file) {
				// We already ensured the folder exists
				await this.vault.createBinary(normalizedPath, arrayBuffer);
				return {path: normalizedPath, status: "created"};
			} else {
				// Path exists but is a folder (or something else unexpected)
				// ensureFolderExists should have thrown if the parent path was a file,
				// so this implies the final path component itself is a folder.
				console.error(`Cannot write file content to ${normalizedPath}, path exists but is not a TFile (Type: ${file?.constructor.name})`);
				throw new Error(`Cannot write file to ${normalizedPath} as it's not a file.`);
			}
		} catch (vaultError) {
			console.error(`Vault operation failed for ${normalizedPath}:`, vaultError);
			throw vaultError;
		}
	}

// ... (Keep updateLocalFiles, createCopyInDir - they use writeToLocal/ensureFolderExists now) ...
	async updateLocalFiles(
		addToLocal: {path: string, content: string}[],
		deleteFromLocal: Array<string>): Promise<FileOpRecord[]> {

		// Normalize paths before processing
		const normalizedAddToLocal = addToLocal.map(item => ({ ...item, path: normalizePath(item.path) }));
		const normalizedDeleteFromLocal = deleteFromLocal.map(normalizePath);

		const writeOpsPromises = normalizedAddToLocal.map(async ({path, content}) => {
			try {
				return await this.writeToLocal(path, content);
			} catch (e) {
				console.error(`Failed write operation for ${path}:`, e.message);
				return null; // Mark failure
			}
		});

		const deleteOpsPromises = normalizedDeleteFromLocal.map(async (path) => {
			try {
				return await this.deleteFromLocal(path);
			} catch (e) {
				// Log delete errors but potentially allow sync to continue if delete fails?
				// Or rely on error being thrown by deleteFromLocal if it's critical.
				console.error(`Failed delete operation for ${path}:`, e.message);
				return null; // Mark failure
			}
		});

		const results = await Promise.all([...writeOpsPromises, ...deleteOpsPromises]);
		return results.filter((op): op is FileOpRecord => op !== null);
	}

	async createCopyInDir(path: string, copyDir = "_fit"): Promise<void> {
		const normalizedPath = normalizePath(path);
		try {
			const file = await this.getTFile(normalizedPath);
			const copyData = await this.vault.readBinary(file);
			const copyPath = normalizePath(`${copyDir}/${normalizedPath}`); // Normalize copy path too

			await this.ensureFolderExists(copyPath); // Ensure target folder exists

			const existingCopy = this.vault.getAbstractFileByPath(copyPath);

			if (existingCopy instanceof TFile) {
				await this.vault.modifyBinary(existingCopy, copyData);
			} else if (!existingCopy) {
				await this.vault.createBinary(copyPath, copyData);
			} else {
				console.warn(`Cannot create copy at ${copyPath}, path exists but is not a file. Deleting and recreating.`);
				await this.vault.delete(existingCopy, true);
				await this.vault.createBinary(copyPath, copyData);
			}
		} catch (e) {
			console.error(`Failed to create copy of ${normalizedPath} at ${copyDir}:`, e);
			throw new Error(`Failed to create copy for ${normalizedPath}: ${e.message}`);
		}
	}
}
