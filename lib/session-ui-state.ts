/**
 * Глобальный режим UI интервью: лобби, активная сессия, архив, блокировка старта.
 */
export type SessionUIState = "lobby" | "active" | "completed" | "blocked";

export function deriveSessionUiState(input: {
  phase: "idle" | "starting" | "connected" | "stopping" | "failed";
  completedInterviewLocked: boolean;
  contextHardReady: boolean;
  hardContextGuardEnabled: boolean;
  hasInterviewSelection: boolean;
}): SessionUIState {
  if (input.completedInterviewLocked) {
    return "completed";
  }
  if (
    input.hardContextGuardEnabled &&
    input.hasInterviewSelection &&
    !input.contextHardReady
  ) {
    return "blocked";
  }
  if (input.phase === "connected") {
    return "active";
  }
  return "lobby";
}
