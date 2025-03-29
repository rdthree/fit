import { TFile, Vault, base64ToArrayBuffer } from "obsidian";
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
    async ensureFolderExists(path: string): Promise<void> {
        // extract folder path, return empty string is no folder path is matched (exclude the last /)
        const folderPath = path.match(/^(.*)\//)?.[1] || '';
        if (folderPath != "") {
            const folder = this.vault.getAbstractFileByPath(folderPath)
            if (!folder) {
                await this.vault.createFolder(folderPath)
            }
        }
    }

	// --- Ensure this handles base64 input correctly ---
	async writeToLocal(path: string, contentBase64: string): Promise<FileOpRecord> {
		const file = this.vault.getAbstractFileByPath(path);
		let arrayBuffer: ArrayBuffer;
		try {
			// Use Buffer for robust conversion
			arrayBuffer = base64ToArrayBuffer(contentBase64);
		} catch (e) {
			console.error(`Error decoding base64 for path: ${path}`, e);
			// Decide how to handle invalid base64 - skip write, write empty, throw?
			// Throwing might be safest to alert about data corruption.
			throw new Error(`Invalid base64 content received for ${path}`);
		}


		try {
			if (file instanceof TFile) {
				await this.vault.modifyBinary(file, arrayBuffer);
				return {path, status: "changed"};
			} else if (!file) {
				await this.ensureFolderExists(path); // Ensure parent folder exists
				await this.vault.createBinary(path, arrayBuffer);
				return {path, status: "created"};
			} else {
				// Path exists but is a folder, or something else unexpected
				console.error(`Cannot write file content to ${path}, it exists but is not a TFile (Type: ${file?.constructor.name})`);
				throw new Error(`Cannot write file to ${path} as it's not a file.`);
			}
		} catch (vaultError) {
			console.error(`Vault operation failed for ${path}:`, vaultError);
			throw vaultError; // Re-throw vault errors
		}
	}

	async updateLocalFiles(
		addToLocal: {path: string, content: string}[], // content is base64
		deleteFromLocal: Array<string>): Promise<FileOpRecord[]> {
		// Process writes (content is base64)
		const writeOpsPromises = addToLocal.map(({path, content}) =>
			this.writeToLocal(path, content).catch(e => {
				console.error(`Failed write operation for ${path}:`, e);
				return null; // Return null on error to filter out later
			})
		);

		// Process deletions
		const deleteOpsPromises = deleteFromLocal.map((path) =>
			this.deleteFromLocal(path).catch(e => {
				console.error(`Failed delete operation for ${path}:`, e);
				return null; // Return null on error
			})
		);

		const results = await Promise.all([...writeOpsPromises, ...deleteOpsPromises]);
		// Filter out null results from failed operations
		return results.filter(op => op !== null) as FileOpRecord[];
	}

	// --- Ensure createCopyInDir handles binary correctly ---
	async createCopyInDir(path: string, copyDir = "_fit"): Promise<void> {
		const file = await this.getTFile(path); // Use ensured TFile getter
		const copyData = await this.vault.readBinary(file);
		const copyPath = `${copyDir}/${path}`;

		await this.ensureFolderExists(copyPath); // Ensure target folder exists

		const existingCopy = this.vault.getAbstractFileByPath(copyPath);
		try {
			if (existingCopy instanceof TFile) {
				await this.vault.modifyBinary(existingCopy, copyData);
			} else if (!existingCopy) {
				await this.vault.createBinary(copyPath, copyData);
			} else {
				// Target path exists but isn't a file (e.g., folder)
				console.warn(`Cannot create copy at ${copyPath}, path exists but is not a file. Deleting and recreating.`);
				await this.vault.delete(existingCopy, true); // Force delete folder/other
				await this.vault.createBinary(copyPath, copyData);
			}
		} catch (e) {
			console.error(`Failed to create copy of ${path} at ${copyPath}:`, e);
			throw e; // Re-throw error
		}
	}
}
