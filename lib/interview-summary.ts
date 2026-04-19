/**
 * Structured interview summary (v2) for HR / observers / webhooks.
 *
 * v2 vs v1:
 *  - Always-on `decision` ("recommended" / "consider" / "rejected") — никаких
 *    "scores pending" / "нужно прослушать запись".
 *  - `confidencePercent` (0..100) вместо текстового low/medium/high.
 *  - `scores4` по 4 шкалам: experience / communication / thinking / objections.
 *  - `scoreTotal` (0..10) — взвешенный итог (0.3 / 0.25 / 0.25 / 0.2).
 *  - `keyFindings` (2–3 фразы) — фокусная сводка.
 *
 * Старые поля (verdict / hiringRecommendation / questionCoverage / vacancyDigest /
 * weaknesses / evaluationPending / scores) ОСТАВЛЕНЫ для backward-compat
 * webhook-интеграций. UI в этой версии их больше не показывает.
 */

export const INTERVIEW_SUMMARY_SCHEMA_VERSION = 2 as const;
export const VACANCY_CONTEXT_MAX_CHARS = 12_000 as const;

// --- v2 core ---

export type InterviewDecision = "recommended" | "consider" | "rejected";

export type InterviewScores4 = {
  /** 1–10. Опыт работы / релевантность бэкграунда. */
  experience: number;
  /** 1–10. Качество коммуникации, ясность речи. */
  communication: number;
  /** 1–10. Структура мышления, аргументация. */
  thinking: number;
  /** 1–10. Работа с возражениями / стрессовыми вопросами. */
  objections: number;
};

// --- v1 leftovers (kept for webhook back-compat — UI не использует) ---

export type InterviewSummaryVerdict = "strong_fit" | "maybe" | "no_fit";
export type InterviewSummaryConfidence = "low" | "medium" | "high";
export type HiringRecommendation = "hire" | "maybe" | "reject";

export type InterviewScoreDimensions = {
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
  // v2 — главные поля
  decision: InterviewDecision;
  confidencePercent: number;
  scores4: InterviewScores4;
  scoreTotal: number;
  keyFindings: string[];
  risks: string[];
  recommendedNextStep: string;
  // backward-compat
  verdict: InterviewSummaryVerdict;
  confidence: InterviewSummaryConfidence;
  roleFit: string;
  strengths: string[];
  gaps: string[];
  questionCoverage: InterviewSummaryQuestionCoverage[];
  salaryExpectations?: string;
  relocationTravel?: string;
  redFlags: string[];
  scores?: InterviewScoreDimensions | null;
  hiringRecommendation?: HiringRecommendation;
  weaknesses?: string[];
  vacancyDigest?: string;
  vacancyTruncated?: boolean;
  notes?: string;
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
  transcript?: Array<{ role: "agent" | "candidate"; text: string; ts: number }>;
};

// --- helpers ---

export function buildVacancyDigestForSummary(
  vacancyText: string | undefined,
  maxChars: number = 2_400
): { digest: string | undefined; truncated: boolean } {
  const raw = (vacancyText ?? "").trim();
  if (!raw) return { digest: undefined, truncated: false };
  if (raw.length <= maxChars) return { digest: raw, truncated: false };
  return {
    digest: `${raw.slice(0, maxChars).trimEnd()}\n\n[…полный текст вакансии в карточке интервью / JobAI…]`,
    truncated: true
  };
}

export function truncateVacancyForContext(
  vacancyText: string | undefined,
  maxChars: number = VACANCY_CONTEXT_MAX_CHARS
): { text: string; truncated: boolean } {
  const raw = (vacancyText ?? "").trim();
  if (!raw) return { text: "", truncated: false };
  if (raw.length <= maxChars) return { text: raw, truncated: false };
  return {
    text: `${raw.slice(0, maxChars)}\n\n[…текст вакансии обрезан для лимита контекста модели; полный текст в JobAI. Не восстанавливай и не дорисовывай скрытую часть — опирайся только на видимый фрагмент.]`,
    truncated: true
  };
}

/** Clamp 1..10 для одной оценки. */
function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(10, Math.round(value * 10) / 10));
}

/** Взвешенный балл по формуле 0.3/0.25/0.25/0.2 → диапазон 1..10. */
export function computeScoreTotal(scores: InterviewScores4): number {
  const total =
    scores.experience * 0.3 +
    scores.communication * 0.25 +
    scores.thinking * 0.25 +
    scores.objections * 0.2;
  return Math.round(total * 10) / 10;
}

/** score → decision по фиксированным порогам. */
export function decisionFromScore(scoreTotal: number): InterviewDecision {
  if (scoreTotal >= 7.5) return "recommended";
  if (scoreTotal >= 5.5) return "consider";
  return "rejected";
}

/** decision → label на русском (для UI/badge). */
export function decisionLabel(decision: InterviewDecision): string {
  if (decision === "recommended") return "Рекомендован";
  if (decision === "rejected") return "Отклонён";
  return "На рассмотрение";
}

/** Маппинг новой decision на старый hiringRecommendation для webhook back-compat. */
function decisionToHiring(decision: InterviewDecision): HiringRecommendation {
  if (decision === "recommended") return "hire";
  if (decision === "rejected") return "reject";
  return "maybe";
}

/** Маппинг decision → старый verdict для webhook back-compat. */
function decisionToVerdict(decision: InterviewDecision): InterviewSummaryVerdict {
  if (decision === "recommended") return "strong_fit";
  if (decision === "rejected") return "no_fit";
  return "maybe";
}

/** Confidence% → старая bucket-confidence для webhook back-compat. */
function percentToBucket(percent: number): InterviewSummaryConfidence {
  if (percent >= 70) return "high";
  if (percent >= 40) return "medium";
  return "low";
}

// --- baseline (no-excuses) ---

/**
 * Detrministic baseline summary. Возвращается когда нет OPENAI_API_KEY ИЛИ
 * когда LLM не ответил. Никаких "scores pending" / "нужно прослушать" — даём
 * консервативную оценку 5/10 по всем шкалам, decision="consider", confidence
 * соответствует объёму известного контекста (vacancy + questions + transcript).
 */
export function buildInterviewSummaryPayload(input: InterviewSummaryContextInput | null): InterviewSummaryPayload {
  const name =
    input?.candidateFullName?.trim() ||
    [input?.candidateFirstName?.trim(), input?.candidateLastName?.trim()].filter(Boolean).join(" ").trim() ||
    "Кандидат";
  const jobTitle = input?.jobTitle?.trim() || "должность не указана";
  const company = input?.companyName?.trim() || "компания не указана";
  const specialty = input?.specialtyName?.trim();

  const { truncated } = truncateVacancyForContext(input?.vacancyText);
  const { digest: vacancyDigest, truncated: digestWasTruncated } = buildVacancyDigestForSummary(input?.vacancyText);
  const hasVacancy = Boolean(vacancyDigest);
  const qCount = (input?.questions ?? []).length;
  const transcriptTurns = input?.transcript?.length ?? 0;

  const ordered = (input?.questions ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((q) => ({
      order: q.order,
      topic: q.text.trim() || `Вопрос ${q.order}`,
      assessment: "not_discussed" as const
    }));

  // Conservative baseline: 5/10 по всем — нет данных для лучше / хуже.
  const scores4: InterviewScores4 = {
    experience: 5,
    communication: 5,
    thinking: 5,
    objections: 5
  };
  const scoreTotal = computeScoreTotal(scores4);
  const decision = decisionFromScore(scoreTotal);

  // Confidence% растёт с объёмом известных данных.
  let confidencePercent = 20;
  if (hasVacancy) confidencePercent += 10;
  if (qCount > 0) confidencePercent += 10;
  if (transcriptTurns >= 5) confidencePercent += 15;
  if (transcriptTurns >= 15) confidencePercent += 10;

  const keyFindings: string[] = [
    `Интервью на позицию «${jobTitle}» в компанию ${company}.`,
    transcriptTurns > 0
      ? `Зафиксировано ${transcriptTurns} реплик диалога — оценка опирается на этот фрагмент.`
      : "Транскрипт диалога не сохранён, оценка опирается на контекст вакансии и сценарий вопросов."
  ];

  const risks: string[] = [];
  if (!hasVacancy) risks.push("В контексте сессии не было полного описания вакансии.");
  if (qCount === 0) risks.push("В сценарии не было сформированного списка вопросов.");
  if (transcriptTurns === 0) risks.push("Полный транскрипт диалога недоступен — для точной оценки нужен повторный разбор.");

  const recommendedNextStep =
    decision === "recommended"
      ? "Назначить финальное интервью с нанимающим менеджером."
      : decision === "consider"
        ? "Провести краткое уточняющее интервью или тестовое задание."
        : "Сообщить отказ и закрыть карточку кандидата.";

  return {
    summarySchemaVersion: INTERVIEW_SUMMARY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    decision,
    confidencePercent: Math.min(100, confidencePercent),
    scores4,
    scoreTotal,
    keyFindings,
    risks,
    recommendedNextStep,
    // backward-compat для webhook'ов:
    verdict: decisionToVerdict(decision),
    confidence: percentToBucket(confidencePercent),
    roleFit: `Позиция «${jobTitle}»${specialty ? ` (${specialty})` : ""}, компания ${company}, кандидат ${name}.`,
    strengths: [],
    gaps: [],
    weaknesses: [],
    redFlags: [],
    questionCoverage: ordered,
    scores: {
      experience1to10: scores4.experience,
      communication1to10: scores4.communication,
      thinking1to10: scores4.thinking
    },
    hiringRecommendation: decisionToHiring(decision),
    vacancyDigest,
    vacancyTruncated: truncated || digestWasTruncated || undefined,
    notes: undefined,
    evaluationPending: false
  };
}

// --- AI draft merge ---

const DECISIONS: InterviewDecision[] = ["recommended", "consider", "rejected"];

function pickDecision(value: unknown): InterviewDecision | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  if ((DECISIONS as string[]).includes(lower)) return lower as InterviewDecision;
  // допускаем альтернативы из старой схемы / synonyms
  if (lower === "hire" || lower === "strong_fit" || lower === "рекомендован") return "recommended";
  if (lower === "reject" || lower === "no_fit" || lower === "отклонён" || lower === "отклонен") return "rejected";
  if (lower === "maybe" || lower === "consider" || lower === "на рассмотрение") return "consider";
  return undefined;
}

function pickPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function pickScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return clampScore(value);
}

function pickStringArray(value: unknown, maxItems = 12): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, maxItems);
  return out.length ? out : undefined;
}

/**
 * Накладывает JSON-ответ LLM (v2 schema) на baseline. Что важно:
 *  - decision / scores / confidence ВСЕГДА перезаписываются из LLM, если LLM
 *    их вернул в валидном виде (никаких "evaluationPending" хвостов).
 *  - scoreTotal вычисляется автоматически из scores4 (LLM может прислать своё,
 *    но мы перевычисляем чтобы гарантировать формулу 0.3/0.25/0.25/0.2).
 *  - decision auto-recompute из scoreTotal если LLM не дал валидного.
 */
export function mergeInterviewSummaryAiDraft(
  baseline: InterviewSummaryPayload,
  draft: unknown,
  meta?: { model: string }
): InterviewSummaryPayload {
  if (!draft || typeof draft !== "object") return baseline;
  const d = draft as Record<string, unknown>;

  const rawScores = (d.scores4 ?? d.scores ?? {}) as Record<string, unknown>;
  const scores4: InterviewScores4 = {
    experience: pickScore(rawScores.experience) ?? pickScore(rawScores.experience1to10) ?? baseline.scores4.experience,
    communication:
      pickScore(rawScores.communication) ??
      pickScore(rawScores.communication1to10) ??
      baseline.scores4.communication,
    thinking: pickScore(rawScores.thinking) ?? pickScore(rawScores.thinking1to10) ?? baseline.scores4.thinking,
    objections:
      pickScore(rawScores.objections) ??
      pickScore(rawScores.objectionHandling) ??
      pickScore(rawScores.objections1to10) ??
      baseline.scores4.objections
  };
  const scoreTotal = computeScoreTotal(scores4);
  const decision = pickDecision(d.decision) ?? decisionFromScore(scoreTotal);
  const confidencePercent =
    pickPercent(d.confidencePercent) ?? pickPercent(d.confidence) ?? baseline.confidencePercent;

  const keyFindings = pickStringArray(d.keyFindings, 5) ?? baseline.keyFindings;
  const risks = pickStringArray(d.risks, 8) ?? baseline.risks;
  const recommendedNextStep =
    typeof d.recommendedNextStep === "string" && d.recommendedNextStep.trim()
      ? d.recommendedNextStep.trim()
      : baseline.recommendedNextStep;
  const aiNotes = typeof d.notes === "string" && d.notes.trim() ? d.notes.trim() : "";
  const modelLine = meta?.model ? `[Оценка дополнена моделью ${meta.model}]` : "";
  const notes = [aiNotes, modelLine].filter(Boolean).join(" · ") || undefined;

  return {
    ...baseline,
    decision,
    confidencePercent,
    scores4,
    scoreTotal,
    keyFindings,
    risks,
    recommendedNextStep,
    notes,
    // backward-compat синхронизация:
    verdict: decisionToVerdict(decision),
    confidence: percentToBucket(confidencePercent),
    hiringRecommendation: decisionToHiring(decision),
    scores: {
      experience1to10: scores4.experience,
      communication1to10: scores4.communication,
      thinking1to10: scores4.thinking
    },
    evaluationPending: false
  };
}

// --- legacy exports (other code may still reference these) ---

export function hiringRecommendationFromVerdict(verdict: InterviewSummaryVerdict): HiringRecommendation {
  if (verdict === "strong_fit") return "hire";
  if (verdict === "no_fit") return "reject";
  return "maybe";
}
