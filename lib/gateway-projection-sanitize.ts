/** Минимальный тип ответа `GET /interviews/:id` (без импорта из `api.ts`, чтобы не было циклов). */
export type InterviewDetailLike = {
  interview: Record<string, unknown>;
  projection: {
    jobAiId?: number;
    nullxesMeetingId?: string;
    sessionId?: string | null;
    [key: string]: unknown;
  };
  prototypeCandidate?: unknown;
};

/** Значения из тестовых curl / доков, случайно сохранённые в projection на gateway. */
export function isGatewayPlaceholderMeetingId(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  if (!v) {
    return false;
  }
  return /REPLACE|placeholder|TODO|FIXME|TBD/i.test(v);
}

export function isGatewayPlaceholderSessionId(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  if (!v) {
    return false;
  }
  return /REPLACE|placeholder|TODO|FIXME|TBD/i.test(v);
}

/**
 * Убирает битые meeting/session из projection (после ошибочного session-link с плейсхолдерами),
 * чтобы UI брал `nullxesMeetingId` / `sessionId` из строки списка или живого состояния сессии.
 */
export function sanitizeInterviewDetail<T extends InterviewDetailLike>(detail: T): T {
  const p = detail.projection;
  const mid = p.nullxesMeetingId?.trim() ?? "";
  const sid = (p.sessionId ?? "").toString().trim();
  const badMid = isGatewayPlaceholderMeetingId(mid);
  const badSid = isGatewayPlaceholderSessionId(sid);
  if (!badMid && !badSid) {
    return detail;
  }
  return {
    ...detail,
    projection: {
      ...p,
      ...(badMid ? { nullxesMeetingId: undefined } : {}),
      ...(badSid ? { sessionId: undefined } : {})
    }
  };
}
