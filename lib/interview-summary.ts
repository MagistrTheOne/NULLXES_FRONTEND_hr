/**
 * Structured interview summary (v1) for HR / observers / webhooks.
 * Generated at session end; does not replace full human review.
 */

export const INTERVIEW_SUMMARY_SCHEMA_VERSION = 1 as const;
export const VACANCY_CONTEXT_MAX_CHARS = 12_000 as const;

export type InterviewSummaryVerdict = "strong_fit" | "maybe" | "no_fit";
export type InterviewSummaryConfidence = "low" | "medium" | "high";

export type InterviewSummaryQuestionCoverage = {
  order: number;
  topic: string;
  assessment: "not_discussed" | "partial" | "clear" | "strong";
  evidenceQuote?: string;
};

export type InterviewSummaryPayload = {
  summarySchemaVersion: typeof INTERVIEW_SUMMARY_SCHEMA_VERSION;
  generatedAt: string;
  verdict: InterviewSummaryVerdict;
  confidence: InterviewSummaryConfidence;
  roleFit: string;
  strengths: string[];
  gaps: string[];
  risks: string[];
  questionCoverage: InterviewSummaryQuestionCoverage[];
  salaryExpectations?: string;
  relocationTravel?: string;
  redFlags: string[];
  recommendedNextStep: string;
  /** When vacancy text was truncated for model context */
  vacancyTruncated?: boolean;
  notes?: string;
};

export type InterviewSummaryContextInput = {
  candidateFullName?: string;
  candidateFirstName?: string;
  candidateLastName?: string;
  jobTitle?: string;
  companyName?: string;
  vacancyText?: string;
  specialtyName?: string;
  questions?: Array<{ text: string; order: number }>;
};

export function truncateVacancyForContext(
  vacancyText: string | undefined,
  maxChars: number = VACANCY_CONTEXT_MAX_CHARS
): { text: string; truncated: boolean } {
  const raw = (vacancyText ?? "").trim();
  if (!raw) {
    return { text: "", truncated: false };
  }
  if (raw.length <= maxChars) {
    return { text: raw, truncated: false };
  }
  return {
    text: `${raw.slice(0, maxChars)}\n\n[…текст вакансии обрезан для лимита контекста модели, полный текст в JobAI…]`,
    truncated: true
  };
}

/**
 * Deterministic baseline summary at end of session (no transcript parsing yet).
 */
export function buildInterviewSummaryPayload(input: InterviewSummaryContextInput | null): InterviewSummaryPayload {
  const name =
    input?.candidateFullName?.trim() ||
    [input?.candidateFirstName?.trim(), input?.candidateLastName?.trim()].filter(Boolean).join(" ").trim() ||
    "кандидат";
  const jobTitle = input?.jobTitle?.trim() || "должность не указана";
  const company = input?.companyName?.trim() || "компания не указана";
  const specialty = input?.specialtyName?.trim();
  const { truncated } = truncateVacancyForContext(input?.vacancyText);

  const ordered = (input?.questions ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((q) => ({
      order: q.order,
      topic: q.text.trim() || `Вопрос ${q.order}`,
      assessment: "not_discussed" as const
    }));

  return {
    summarySchemaVersion: INTERVIEW_SUMMARY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    verdict: "maybe",
    confidence: "low",
    roleFit: `Позиция: ${jobTitle}${specialty ? ` · специализация: ${specialty}` : ""}. Компания: ${company}. Кандидат: ${name}.`,
    strengths: [],
    gaps: ["Нет автоматической оценки ответов без транскрипта сессии."],
    risks: [],
    questionCoverage: ordered,
    redFlags: [],
    recommendedNextStep: "Прослушать запись / провести debrief с кандидатом и принять решение по воронке.",
    vacancyTruncated: truncated || undefined,
    notes:
      "Автоматическое резюме по контексту вакансии и списку вопросов. Для детального scorecard нужна интеграция транскрипта."
  };
}
