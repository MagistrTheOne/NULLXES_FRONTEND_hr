/** ЧТЗ п.3.2 — общий статус собеседования (LiveKit / JobAI WebRTC V2). */
export type MainUIStatus = "waiting" | "ready_to_start" | "in_process" | "finished";

export function deriveMainUiStatus(input: {
  meetingAtIso: string;
  hasStartedSession: boolean;
  pingStopped: boolean;
}): MainUIStatus {
  if (input.pingStopped) return "finished";
  if (input.hasStartedSession) return "in_process";
  const t = Date.parse(input.meetingAtIso);
  if (Number.isFinite(t) && Date.now() < t) return "waiting";
  return "ready_to_start";
}
