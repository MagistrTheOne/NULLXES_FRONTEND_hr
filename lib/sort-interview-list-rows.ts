import type { InterviewListRow } from "@/lib/api";

function timeMs(iso: string | undefined): number {
  if (!iso?.trim()) {
    return 0;
  }
  const t = new Date(iso.trim()).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Список для UI: новые записи (по времени создания на gateway / JobAI) — выше, старые ниже.
 * Доп. ключи — на случай одинакового createdAt.
 */
export function sortInterviewListRowsNewestFirst(rows: InterviewListRow[]): InterviewListRow[] {
  return [...rows].sort((a, b) => {
    const ca = timeMs(a.createdAt);
    const cb = timeMs(b.createdAt);
    if (cb !== ca) {
      return cb - ca;
    }
    const ua = timeMs(a.updatedAt);
    const ub = timeMs(b.updatedAt);
    if (ub !== ua) {
      return ub - ua;
    }
    const sa = timeMs(a.statusChangedAt);
    const sb = timeMs(b.statusChangedAt);
    if (sb !== sa) {
      return sb - sa;
    }
    return b.jobAiId - a.jobAiId;
  });
}
