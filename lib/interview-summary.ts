/**
 * Structured interview summary (v1) for HR / observers / webhooks.
 * Generated at session end; does not replace full human review.
 */

export const INTERVIEW_SUMMARY_SCHEMA_VERSION = 1 as const;
export const VACANCY_CONTEXT_MAX_CHARS = 12_000 as const;

export type InterviewSummaryVerdict = "strong_fit" | "maybe" | "no_fit";
export type InterviewSummaryConfidence = "low" | "medium" | "high";
/** Явная рекомендация по воронке (согласуется с verdict) */
export type HiringRecommendation = "hire" | "maybe" | "reject";

export type InterviewScoreDimensions = {
  /** 1–10; без транскрипта автооценка не выставляется */
  experience1to10?: number | null;
  communication1to10?: number | null;
  thinking1to10?: number | null;
};

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
  /** Оценка по осям 1–10; при отсутствии транскрипта — null/пропуск */
  scores?: InterviewScoreDimensions | null;
  /** Дублирует смысл verdict для интеграций, ожидающих hire/maybe/reject */
  hiringRecommendation?: HiringRecommendation;
  /** Слабые стороны (синоним gaps для HR-отчётов; без транскрипта — пояснение-заглушка) */
  weaknesses?: string[];
  /** Короткая выдержка JD для карточки итога (без «угадываний» по ответам кандидата) */
  vacancyDigest?: string;
  /** When vacancy text was truncated for model context */
  vacancyTruncated?: boolean;
  notes?: string;
  /** true, пока оценки по шкале выставляются только вручную / после транскрипта */
  evaluationPending?: boolean;
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
  /**
   * Optional dialog transcript captured during the interview. When present,
   * the summary route switches to the "with-transcript" system prompt and
   * fills questionCoverage / scores / hiringRecommendation from real answers
   * instead of producing a baseline-only response.
   */
  transcript?: Array<{ role: "agent" | "candidate"; text: string; ts: number }>;
};

/** Выдержка для UI саммари: ограничение длины, без лишних пробелов между строками */
export function buildVacancyDigestForSummary(
  vacancyText: string | undefined,
  maxChars: number = 2_400
): { digest: string | undefined; truncated: boolean } {
  const raw = (vacancyText ?? "").trim();
  if (!raw) {
    return { digest: undefined, truncated: false };
  }
  if (raw.length <= maxChars) {
    return { digest: raw, truncated: false };
  }
  return {
    digest: `${raw.slice(0, maxChars).trimEnd()}\n\n[…полный текст вакансии в карточке интервью / JobAI…]`,
    truncated: true
  };
}

export function hiringRecommendationFromVerdict(verdict: InterviewSummaryVerdict): HiringRecommendation {
  if (verdict === "strong_fit") {
    return "hire";
  }
  if (verdict === "no_fit") {
    return "reject";
  }
  return "maybe";
}

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
    text: `${raw.slice(0, maxChars)}\n\n[…текст вакансии обрезан для лимита контекста модели; полный текст в JobAI. Не восстанавливай и не дорисовывай скрытую часть — опирайся только на видимый фрагмент.]`,
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
  const { digest: vacancyDigest, truncated: digestWasTruncated } = buildVacancyDigestForSummary(input?.vacancyText);
  const hasVacancy = Boolean(vacancyDigest);
  const qCount = (input?.questions ?? []).length;
  const hasStructuredPlan = hasVacancy && qCount > 0;

  const ordered = (input?.questions ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((q) => ({
      order: q.order,
      topic: q.text.trim() || `Вопрос ${q.order}`,
      assessment: "not_discussed" as const
    }));

  const gaps: string[] = [
    "Нет автоматической оценки ответов без транскрипта сессии.",
    hasStructuredPlan
      ? "Статусы вопросов ниже — «not_discussed»: без записи диалога система не фиксирует факт обсуждения."
      : "Контекст вакансии или список вопросов неполные — проверьте данные интервью на gateway."
  ];
  const strengths: string[] = [];
  if (hasStructuredPlan) {
    strengths.push(
      "В сессию заложены текст вакансии и сценарий вопросов — при разборе записи сверяйте ответы с требованиями JD."
    );
  }

  const verdict: InterviewSummaryVerdict = "maybe";
  const weaknessNote =
    "Количественные оценки (опыт / коммуникация / мышление) и слабые стороны по шкале 1–10 требуют прослушивания записи или транскрипта.";

  return {
    summarySchemaVersion: INTERVIEW_SUMMARY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    verdict,
    confidence: hasStructuredPlan ? "medium" : "low",
    roleFit: `Позиция: ${jobTitle}${specialty ? ` · специализация: ${specialty}` : ""}. Компания: ${company}. Кандидат: ${name}.`,
    strengths,
    gaps,
    weaknesses: [weaknessNote],
    risks: [],
    questionCoverage: ordered,
    redFlags: [],
    recommendedNextStep: "Прослушать запись / провести debrief с кандидатом и принять решение по воронке.",
    scores: {
      experience1to10: null,
      communication1to10: null,
      thinking1to10: null
    },
    hiringRecommendation: hiringRecommendationFromVerdict(verdict),
    evaluationPending: true,
    vacancyDigest,
    vacancyTruncated: truncated || digestWasTruncated || undefined,
    notes: hasStructuredPlan
      ? "Ниже — выдержка вакансии, попавшая в контекст интервью. Рубрика 1–10 и итоговая рекомендация hire/maybe/reject заполняются после анализа записи; устный summary в конце звонка задаётся инструкциями агента."
      : "Заполните вакансию и вопросы в интервью, чтобы итог опирался на полный контекст. Рубрика 1–10 — после транскрипта или ручного разбора."
  };
}

const VERDICTS: InterviewSummaryVerdict[] = ["strong_fit", "maybe", "no_fit"];
const CONFIDENCES: InterviewSummaryConfidence[] = ["low", "medium", "high"];

function pickVerdict(value: unknown): InterviewSummaryVerdict | undefined {
  return typeof value === "string" && (VERDICTS as string[]).includes(value) ? (value as InterviewSummaryVerdict) : undefined;
}

function pickConfidence(value: unknown): InterviewSummaryConfidence | undefined {
  return typeof value === "string" && (CONFIDENCES as string[]).includes(value)
    ? (value as InterviewSummaryConfidence)
    : undefined;
}

function pickStringArray(value: unknown, maxItems = 12): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, maxItems);
  return out.length ? out : undefined;
}

/**
 * Накладывает JSON-ответ LLM на детерминированный baseline.
 * Покрытие вопросов и числовые scores без транскрипта остаются из baseline.
 */
export function mergeInterviewSummaryAiDraft(
  baseline: InterviewSummaryPayload,
  draft: unknown,
  meta?: { model: string }
): InterviewSummaryPayload {
  if (!draft || typeof draft !== "object") {
    return baseline;
  }
  const d = draft as Record<string, unknown>;
  const verdict = pickVerdict(d.verdict) ?? baseline.verdict;
  const confidence = pickConfidence(d.confidence) ?? baseline.confidence;
  const roleFit = typeof d.roleFit === "string" && d.roleFit.trim() ? d.roleFit.trim() : baseline.roleFit;
  const strengths = pickStringArray(d.strengths) ?? baseline.strengths;
  const gaps = pickStringArray(d.gaps) ?? baseline.gaps;
  const risks = pickStringArray(d.risks) ?? baseline.risks;
  const redFlags = pickStringArray(d.redFlags) ?? baseline.redFlags;
  const weaknesses = pickStringArray(d.weaknesses) ?? baseline.weaknesses;
  const recommendedNextStep =
    typeof d.recommendedNextStep === "string" && d.recommendedNextStep.trim()
      ? d.recommendedNextStep.trim()
      : baseline.recommendedNextStep;
  const aiNotes = typeof d.notes === "string" && d.notes.trim() ? d.notes.trim() : "";
  const modelLine = meta?.model ? `\n\n[Итог дополнен моделью ${meta.model} по JD и сценарию вопросов; без транскрипта сессии.]` : "";
  const notes = [baseline.notes, aiNotes, modelLine].filter(Boolean).join("\n\n");

  return {
    ...baseline,
    verdict,
    confidence,
    roleFit,
    strengths,
    gaps,
    risks,
    redFlags,
    weaknesses,
    recommendedNextStep,
    notes,
    hiringRecommendation: hiringRecommendationFromVerdict(verdict),
    questionCoverage: baseline.questionCoverage,
    scores: baseline.scores,
    evaluationPending: baseline.evaluationPending
  };
}
