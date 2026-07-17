import type { StorageDatabase, StorageHostConfig } from "#storage/storage-contract";
import {
  configureStorageHost as configureInternalStorageHost,
  resetStorageHost as resetInternalStorageHost,
  storageDatabase,
} from "#storage/storage-host";

/** Configure the lazy process-local storage boundary and return an idempotent disposer. */
export const configureStorageHost: (options: StorageHostConfig) => () => void =
  configureInternalStorageHost;

/** Remove every configured host layer and restore standalone fallbacks. */
export const resetStorageHost: () => void = resetInternalStorageHost;

/** Stable structurally typed proxy over the currently active database. */
export const db: StorageDatabase = storageDatabase;
