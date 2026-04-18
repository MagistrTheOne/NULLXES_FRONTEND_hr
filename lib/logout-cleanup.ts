/**
 * Вызывается перед authClient.signOut().
 * Подпишитесь на {@link LOGOUT_EVENT}, чтобы закрыть WebRTC, интервью и client state.
 */
export const LOGOUT_EVENT = "jobaidemo:before-logout" as const;

export async function cleanupBeforeLogout(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(LOGOUT_EVENT, { bubbles: true }));
}
