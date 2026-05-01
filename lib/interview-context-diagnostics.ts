/**
 * Диагностика контекста интервью (gateway → merge → агент) без догадок:
 * одна структура для логов и для lastAgentContextTrace.
 *
 * Реалтайм-gateway в этом репозитории не vendored — см. backend/README.md
 */
import type { InterviewDetail } from "@/lib/api";
import { extractCoreFieldsFromInterviewRaw } from "@/lib/interview-detail-fields";
import type { InterviewStartContext } from "@/lib/interview-start-context";

export type SpecialtyFieldShape =
  | "object_with_questions"
  | "object_without_questions"
  | "string"
  | "null_or_other";

export function describeSpecialtyField(raw: unknown): SpecialtyFieldShape {
  if (raw == null) {
    return "null_or_other";
  }
  if (typeof raw === "string") {
    return "string";
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const q = (raw as { questions?: unknown }).questions;
    return Array.isArray(q) && q.length > 0 ? "object_with_questions" : "object_without_questions";
  }
  return "null_or_other";
}

export type InterviewContextDiagnostics = {
  /** Где снят снимок: shell UI, start после merge, session.update sync и т.д. */
  stage: string;
  interviewId?: number;
  triggerSource?: string;
  vacancyTextLen: number;
  hasVacancyText: boolean;
  hasGreetingSpeech: boolean;
  greetingSpeechLen: number;
  questionsCount: number;
  specialtyShape: SpecialtyFieldShape;
  /** Имя кандидата в контексте (превью для сверки с JobAI) */
  candidatePreview: string;
  jobTitlePreview: string;
  companyPreview: string;
  /** Ключи сырого interview (как на gateway) — для сравнения с curl `interview | keys` */
  rawInterviewKeyCount: number;
  rawInterviewKeysSample: string[];
};

function preview(s: string | undefined, max = 80): string {
  const t = (s ?? "").trim();
  if (!t) {
    return "—";
  }
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function buildInterviewContextDiagnostics(
  ctx: InterviewStartContext | null | undefined,
  meta: {
    stage: string;
    interviewId?: number;
    triggerSource?: string;
    rawInterview?: Record<string, unknown> | null;
  }
): InterviewContextDiagnostics {
  const raw = meta.rawInterview;
  const vt = ctx?.vacancyText?.trim() ?? "";
  const gs = ctx?.greetingSpeech?.trim() ?? "";
  const keys = raw ? Object.keys(raw).sort() : [];
  return {
    stage: meta.stage,
    interviewId: meta.interviewId,
    triggerSource: meta.triggerSource,
    vacancyTextLen: vt.length,
    hasVacancyText: vt.length > 0,
    hasGreetingSpeech: gs.length > 0,
    greetingSpeechLen: gs.length,
    questionsCount: ctx?.questions?.length ?? 0,
    specialtyShape: describeSpecialtyField(raw?.specialty),
    candidatePreview: preview(
      ctx?.candidateFullName ||
        [ctx?.candidateFirstName, ctx?.candidateLastName].filter(Boolean).join(" ").trim()
    ),
    jobTitlePreview: preview(ctx?.jobTitle),
    companyPreview: preview(ctx?.companyName),
    rawInterviewKeyCount: keys.length,
    rawInterviewKeysSample: keys.slice(0, 40)
  };
}

/** Снимок полей экстрактора vs сырого JSON — если extractor пустой, а ключи есть на gateway, проблема в ключах/форме. */
export function buildGatewayVsExtractorHint(rawInterview: Record<string, unknown> | null | undefined): {
  extractor: ReturnType<typeof extractCoreFieldsFromInterviewRaw>;
  rawHasVacancyTextKey: boolean;
} {
  const ext = rawInterview ? extractCoreFieldsFromInterviewRaw(rawInterview) : { jobTitle: undefined, vacancyText: undefined, companyName: undefined, specialtyName: undefined };
  const rawHasVacancyTextKey =
    Boolean(rawInterview && ("vacancyText" in rawInterview || "vacancy_text" in rawInterview || "vacancy" in rawInterview));
  return { extractor: ext, rawHasVacancyTextKey };
}

export function isInterviewContextDebugEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEBUG_INTERVIEW_CONTEXT === "1";
}

export function logInterviewContextDiagnostics(
  label: string,
  diag: InterviewContextDiagnostics,
  extra?: { gatewayHint?: ReturnType<typeof buildGatewayVsExtractorHint> }
): void {
  void label;
  void diag;
  void extra;
  // prod: diagnostics logging removed
}

export function diagnosticsFromInterviewDetail(
  detail: InterviewDetail | null | undefined,
  ctx: InterviewStartContext | undefined,
  stage: string,
  extra?: { interviewId?: number; triggerSource?: string }
): InterviewContextDiagnostics {
  const raw = (detail?.interview ?? null) as Record<string, unknown> | null;
  return buildInterviewContextDiagnostics(ctx, {
    stage,
    interviewId: extra?.interviewId ?? detail?.interview?.id,
    triggerSource: extra?.triggerSource,
    rawInterview: raw
  });
}

/** Снимок для UI / отладки: что реально ушло в session.update по контексту. */
export type AgentContextTrace = {
  sentAt: string;
  interviewId?: number;
  meetingId: string;
  sessionId: string;
  candidateFullName?: string;
  companyName?: string;
  jobTitle?: string;
  questionsCount: number;
  diagnostics?: InterviewContextDiagnostics;
};

export function createAgentContextTrace(
  effectiveContext: InterviewStartContext | undefined,
  detail: InterviewDetail | undefined | null,
  meta: {
    meetingId: string;
    sessionId: string;
    interviewId?: number;
    stage: string;
    triggerSource?: string;
  }
): AgentContextTrace {
  const diag = diagnosticsFromInterviewDetail(detail ?? null, effectiveContext, meta.stage, {
    interviewId: meta.interviewId,
    triggerSource: meta.triggerSource
  });
  const raw = detail?.interview as Record<string, unknown> | undefined;
  logInterviewContextDiagnostics(
    meta.stage,
    diag,
    raw ? { gatewayHint: buildGatewayVsExtractorHint(raw) } : undefined
  );
  return {
    sentAt: new Date().toISOString(),
    interviewId: meta.interviewId,
    meetingId: meta.meetingId,
    sessionId: meta.sessionId,
    candidateFullName:
      effectiveContext?.candidateFullName ||
      [effectiveContext?.candidateFirstName, effectiveContext?.candidateLastName].filter(Boolean).join(" ").trim(),
    companyName: effectiveContext?.companyName,
    jobTitle: effectiveContext?.jobTitle,
    questionsCount: effectiveContext?.questions?.length ?? 0,
    diagnostics: diag
  };
}
