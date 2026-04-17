/** Scheduled instant is still in the future (join / stream not allowed yet). */
export function isMeetingNotYetOpen(meetingAt?: string | null): boolean {
  if (!meetingAt?.trim()) {
    return false;
  }
  const ts = new Date(meetingAt).getTime();
  return Number.isFinite(ts) && Date.now() < ts;
}

export function formatCandidateMeetingLobbyMessage(meetingAt: string): string {
  const ts = new Date(meetingAt).getTime();
  if (!Number.isFinite(ts)) {
    return "Собеседование пока нельзя начать: некорректное время встречи.";
  }
  return `Встреча станет доступна с ${new Date(ts).toLocaleString("ru-RU")}.`;
}
