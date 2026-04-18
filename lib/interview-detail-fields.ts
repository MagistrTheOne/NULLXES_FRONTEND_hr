import type { InterviewDetail } from "@/lib/api";
import type { InterviewStartContext } from "@/lib/interview-start-context";

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) {
    return v.trim();
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  return undefined;
}

function vacancyFromNested(raw: unknown): string | undefined {
  if (raw == null) {
    return undefined;
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  return str(o.text) ?? str(o.body) ?? str(o.description) ?? str(o.content) ?? str(o.fullText);
}

/**
 * Достаёт должность / текст вакансии / компанию из «сырого» объекта интервью с gateway/JobAI.
 * Учитывает альтернативные ключи и вложенный `vacancy`, чтобы агент не терял контекст при расхождении схемы.
 */
export function extractCoreFieldsFromInterviewRaw(interview: Record<string, unknown>): {
  jobTitle?: string;
  vacancyText?: string;
  companyName?: string;
  specialtyName?: string;
  questions?: InterviewStartContext["questions"];
} {
  const specialty = interview.specialty;
  const specRec = specialty && typeof specialty === "object" ? (specialty as Record<string, unknown>) : undefined;
  const specialtyNameFromObject = specRec ? str(specRec.name) : undefined;
  const specialtyName =
    specialtyNameFromObject ??
    (typeof specialty === "string" && specialty.trim() ? specialty.trim() : undefined);

  const jobTitle =
    str(interview.jobTitle) ??
    str(interview.job_title) ??
    str(interview.title) ??
    str(interview.positionTitle) ??
    str(interview.position_title) ??
    specialtyName;

  const vacancyText =
    str(interview.vacancyText) ??
    str(interview.vacancy_text) ??
    str(interview.vacancyDescription) ??
    str(interview.vacancy_description) ??
    str(interview.description) ??
    str(interview.jobDescription) ??
    str(interview.job_description) ??
    vacancyFromNested(interview.vacancy);

  const companyName =
    str(interview.companyName) ?? str(interview.company_name) ?? str(interview.company);

  const questions =
    specRec && Array.isArray(specRec.questions) && specRec.questions.length > 0
      ? (specRec.questions as NonNullable<InterviewStartContext["questions"]>)
      : undefined;

  return { jobTitle, vacancyText, companyName, specialtyName, questions };
}

function pickNonEmpty(a: string | undefined, b: string | undefined): string | undefined {
  const ta = (a ?? "").trim();
  if (ta) {
    return a!.trim();
  }
  const tb = (b ?? "").trim();
  return tb ? b!.trim() : undefined;
}

/** Список интервью часто отдаёт укороченный vacancyText; после sync с gateway берём более полный текст. */
function pickRicherVacancy(a: string | undefined, b: string | undefined): string | undefined {
  const ta = (a ?? "").trim();
  const tb = (b ?? "").trim();
  if (!ta) {
    return tb || undefined;
  }
  if (!tb) {
    return ta;
  }
  return tb.length > ta.length ? tb : ta;
}

/**
 * Объединяет уже собранный UI-контекст с актуальным `InterviewDetail` (после sync).
 * Непустые поля из `base` сохраняются; пустые добиваются из детали + нормализации сырого JSON.
 */
export function mergeStartContextWithInterviewDetail(
  base: InterviewStartContext | undefined,
  detail: InterviewDetail
): InterviewStartContext {
  const inv = detail.interview as Record<string, unknown>;
  const ext = extractCoreFieldsFromInterviewRaw(inv);
  const typed = detail.interview;

  const fullFromProto = detail.prototypeCandidate?.sourceFullName?.trim();
  const fullFromApi = [str(inv.candidateFirstName), str(inv.candidateLastName)].filter(Boolean).join(" ").trim();

  const detailQuestions =
    typeof typed.specialty === "object" && typed.specialty && Array.isArray(typed.specialty.questions)
      ? typed.specialty.questions
      : undefined;
  const mergedQuestions =
    (detailQuestions && detailQuestions.length > 0 ? detailQuestions : undefined) ??
    (ext.questions && ext.questions.length > 0 ? ext.questions : undefined) ??
    (base?.questions && base.questions.length > 0 ? base.questions : undefined);

  return {
    candidateFirstName: pickNonEmpty(base?.candidateFirstName, str(inv.candidateFirstName)),
    candidateLastName: pickNonEmpty(base?.candidateLastName, str(inv.candidateLastName)),
    candidateFullName: pickNonEmpty(base?.candidateFullName, fullFromProto || fullFromApi || undefined),
    jobTitle: pickNonEmpty(base?.jobTitle, ext.jobTitle),
    vacancyText: pickRicherVacancy(base?.vacancyText, ext.vacancyText),
    companyName: pickNonEmpty(base?.companyName, ext.companyName),
    specialtyName: pickNonEmpty(base?.specialtyName, ext.specialtyName ?? typed.specialty?.name),
    greetingSpeech: pickNonEmpty(
      base?.greetingSpeech,
      (typed.greetingSpeechResolved as string | undefined) ?? typed.greetingSpeech
    ),
    finalSpeech: pickNonEmpty(
      base?.finalSpeech,
      (typed.finalSpeechResolved as string | undefined) ?? typed.finalSpeech
    ),
    questions: mergedQuestions
  };
}
