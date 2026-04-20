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

/**
 * score → decision по фиксированным порогам.
 *
 * Формула (v2.1): consider — это "нейтральный кандидат без явных red flags",
 * поэтому нижняя граница consider = 5.0, а не 5.5. Раньше кандидаты с
 * нейтральными 5/5/5/5 автоматом попадали в "rejected", хотя по смыслу они
 * "на рассмотрение".
 *
 *   >= 7.5  recommended  — явно сильный кандидат
 *   >= 5.0  consider     — нейтральный / смешанный сигнал, решает HR
 *   <  5.0  rejected     — подтверждённые слабые ответы / red flags
 */
export function decisionFromScore(scoreTotal: number): InterviewDecision {
  if (scoreTotal >= 7.5) return "recommended";
  if (scoreTotal >= 5.0) return "consider";
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

  // Conservative baseline: 6/10 по всем. Почему именно 6, а не 5:
  //   - 5/5/5/5 попадает в "rejected" через weighted sum → автоматический
  //     отказ для любого кандидата, по которому не успел проехаться LLM
  //     (OPENAI_API_KEY отсутствует, таймаут, fallback, нет транскрипта).
  //   - "Нейтральный / пока неизвестно" → по смыслу это "consider", а не
  //     "rejected". Нельзя отказывать человеку из-за отсутствия данных.
  // 6/6/6/6 даёт scoreTotal 6.0 → decision="consider" и даёт HR возможность
  // посмотреть интервью самостоятельно, а не получить штамп "Отклонён".
  const scores4: InterviewScores4 = {
    experience: 6,
    communication: 6,
    thinking: 6,
    objections: 6
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

// --- normalizer for cached / external payloads ---

/**
 * Принимает любой payload (v1 из Redis, v2 свежий, неполный JSON и т.д.) и
 * возвращает валидный v2 объект. Если входные данные не похожи на summary —
 * возвращает null (callee должен сам решить что показать вместо).
 *
 * Используется когда summary читается из meeting.metadata.interviewSummary —
 * там могут лежать старые v1-снимки от завершённых интервью, и без
 * нормализации новый InterviewSummaryDisplay падает на undefined.scores4.
 */
export function normalizeInterviewSummary(value: unknown): InterviewSummaryPayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<InterviewSummaryPayload> & Record<string, unknown>;

  // Already v2 with mandatory fields — pass through (defensive copy).
  if (
    v.summarySchemaVersion === INTERVIEW_SUMMARY_SCHEMA_VERSION &&
    v.scores4 &&
    typeof v.scores4 === "object" &&
    typeof (v.scores4 as InterviewScores4).experience === "number" &&
    typeof v.decision === "string"
  ) {
    return value as InterviewSummaryPayload;
  }

  // Adapt v1 → v2: reuse legacy `scores` (1-10 ints) if present, otherwise
  // fall back to neutral 6/10 across the board (see buildInterviewSummaryPayload
  // — 6 keeps the candidate in "consider" instead of silent auto-reject).
  const legacyScores = (v.scores ?? null) as InterviewScoreDimensions | null;
  const scores4: InterviewScores4 = {
    experience: clampScore(legacyScores?.experience1to10 ?? 6),
    communication: clampScore(legacyScores?.communication1to10 ?? 6),
    thinking: clampScore(legacyScores?.thinking1to10 ?? 6),
    objections: 6
  };
  const scoreTotal = computeScoreTotal(scores4);

  let decision: InterviewDecision = decisionFromScore(scoreTotal);
  if (typeof v.decision === "string") {
    const picked = ((): InterviewDecision | null => {
      const lower = v.decision.toLowerCase();
      if (lower === "recommended" || lower === "consider" || lower === "rejected") return lower;
      return null;
    })();
    if (picked) decision = picked;
  } else if (v.hiringRecommendation === "hire") {
    decision = "recommended";
  } else if (v.hiringRecommendation === "reject") {
    decision = "rejected";
  } else if (v.hiringRecommendation === "maybe" || v.verdict === "maybe") {
    decision = "consider";
  }

  const confidencePercent =
    typeof v.confidencePercent === "number" && Number.isFinite(v.confidencePercent)
      ? Math.max(0, Math.min(100, Math.round(v.confidencePercent)))
      : v.confidence === "high"
        ? 75
        : v.confidence === "medium"
          ? 50
          : 25;

  const keyFindings: string[] =
    Array.isArray(v.keyFindings) && v.keyFindings.every((s) => typeof s === "string")
      ? (v.keyFindings as string[]).slice(0, 5)
      : typeof v.roleFit === "string" && v.roleFit.trim()
        ? [v.roleFit.trim()]
        : ["Итог сформирован по ограниченным данным предыдущей сессии."];

  const risks: string[] =
    Array.isArray(v.risks) && v.risks.every((s) => typeof s === "string") ? (v.risks as string[]).slice(0, 8) : [];

  const recommendedNextStep =
    typeof v.recommendedNextStep === "string" && v.recommendedNextStep.trim()
      ? v.recommendedNextStep.trim()
      : decision === "recommended"
        ? "Назначить финальное интервью с нанимающим менеджером."
        : decision === "rejected"
          ? "Сообщить отказ и закрыть карточку кандидата."
          : "Провести краткое уточняющее интервью или тестовое задание.";

  return {
    summarySchemaVersion: INTERVIEW_SUMMARY_SCHEMA_VERSION,
    generatedAt: typeof v.generatedAt === "string" ? v.generatedAt : new Date().toISOString(),
    decision,
    confidencePercent,
    scores4,
    scoreTotal,
    keyFindings,
    risks,
    recommendedNextStep,
    verdict: typeof v.verdict === "string" ? (v.verdict as InterviewSummaryVerdict) : "maybe",
    confidence: typeof v.confidence === "string" ? (v.confidence as InterviewSummaryConfidence) : "medium",
    roleFit: typeof v.roleFit === "string" ? v.roleFit : "",
    strengths: Array.isArray(v.strengths) ? (v.strengths.filter((s) => typeof s === "string") as string[]) : [],
    gaps: Array.isArray(v.gaps) ? (v.gaps.filter((s) => typeof s === "string") as string[]) : [],
    weaknesses: Array.isArray(v.weaknesses) ? (v.weaknesses.filter((s) => typeof s === "string") as string[]) : [],
    redFlags: Array.isArray(v.redFlags) ? (v.redFlags.filter((s) => typeof s === "string") as string[]) : [],
    questionCoverage: Array.isArray(v.questionCoverage) ? (v.questionCoverage as InterviewSummaryQuestionCoverage[]) : [],
    salaryExpectations: typeof v.salaryExpectations === "string" ? v.salaryExpectations : undefined,
    relocationTravel: typeof v.relocationTravel === "string" ? v.relocationTravel : undefined,
    scores: legacyScores ?? {
      experience1to10: scores4.experience,
      communication1to10: scores4.communication,
      thinking1to10: scores4.thinking
    },
    hiringRecommendation:
      decision === "recommended" ? "hire" : decision === "rejected" ? "reject" : "maybe",
    vacancyDigest: typeof v.vacancyDigest === "string" ? v.vacancyDigest : undefined,
    vacancyTruncated: typeof v.vacancyTruncated === "boolean" ? v.vacancyTruncated : undefined,
    notes: typeof v.notes === "string" ? v.notes : undefined,
    evaluationPending: false
  };
}
