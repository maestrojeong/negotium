import { removePlaywrightProfileData } from "#platform/playwright/manager";
import { assertBrowserProfileDeletable, deleteBrowserProfile } from "#storage/browser-profiles";

export interface DeleteManagedBrowserProfileResult {
  profile: string;
  metadataRemoved: boolean;
  dataRemoved: boolean;
  processStopped: boolean;
}

/** Delete an unused named profile while serialized against browser startup. */
export async function deleteManagedBrowserProfile(
  ownerId: string,
  rawProfile: string,
): Promise<DeleteManagedBrowserProfileResult> {
  const profile = assertBrowserProfileDeletable(ownerId, rawProfile);
  let metadataRemoved = false;
  const removed = await removePlaywrightProfileData(ownerId, profile, {
    beforeRemove: () => {
      assertBrowserProfileDeletable(ownerId, profile);
    },
    afterRemove: () => {
      metadataRemoved = deleteBrowserProfile(ownerId, profile);
    },
  });

  return {
    profile,
    metadataRemoved,
    dataRemoved: removed.dataRemoved,
    processStopped: removed.processStopped,
  };
}
