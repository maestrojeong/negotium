import type { StorageDatabase } from "#storage/storage-contract";
import { internalStorageDatabase } from "#storage/storage-host";

export const db = internalStorageDatabase as unknown as StorageDatabase;
