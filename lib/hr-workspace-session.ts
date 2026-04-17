/** Marks this browser tab as HR workspace so `entry=candidate` links still show the full operator shell. */
export const HR_WORKSPACE_SESSION_KEY = "nullxes_hr_workspace_v1";

export function markHrWorkspaceInBrowser(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    sessionStorage.setItem(HR_WORKSPACE_SESSION_KEY, "1");
  } catch {
    // ignore quota / private mode
  }
}

export function hasHrWorkspaceInBrowser(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return sessionStorage.getItem(HR_WORKSPACE_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}
