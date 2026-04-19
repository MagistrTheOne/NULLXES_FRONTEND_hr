import { NextRequest, NextResponse } from "next/server";
import {
  buildInterviewSummaryPayload,
  mergeInterviewSummaryAiDraft,
  truncateVacancyForContext,
  type InterviewSummaryContextInput
} from "@/lib/interview-summary";

export const runtime = "nodejs";

const DEFAULT_MODEL = "gpt-4o";

/** System prompt used when no transcript is available (legacy / aborted sessions). */
const SYSTEM_NO_TRANSCRIPT = `Ты HR-аналитик. На входе — только карточка интервью: кандидат, компания, должность, фрагмент вакансии, список вопросов (с order). Транскрипта диалога НЕТ.

Верни один JSON-объект (без markdown) со строго такими ключами:
- verdict: одно из "strong_fit" | "maybe" | "no_fit" — оценка насколько типичный профиль по JD выглядит разумным для роли (без ответов кандидата будь консервативен: чаще "maybe").
- confidence: "low" | "medium" | "high" — насколько уверенно можно судить без диалога (обычно "low" или "medium").
- roleFit: одна строка по-русски: позиция, компания, кандидат, 1–2 предложения о соответствии требованиям JD только на уровне «ожидаемого профиля», без выдуманных фактов из разговора.
- strengths: массив строк — сильные стороны с точки зрения JD (что в типичном кейсе важно для роли), не приписывай кандидату ответы.
- gaps: массив строк — что нельзя оценить без записи; явно укажи отсутствие транскрипта.
- risks: массив строк — потенциальные риски из формулировок вакансии или чувствительных тем в списке вопросов (если нечего — []).
- redFlags: массив строк — только если в JD/вопросах есть явные юридические или этические проблемы формулировок; иначе [].
- weaknesses: массив строк — зоны неопределённости для рекрутёра без диалога.
- recommendedNextStep: одна строка — практичный следующий шаг для HR.
- notes: кратко по-русски: что сделано автоматически и что нужен человек/запись.

Не включай в JSON поля questionCoverage, scores, summarySchemaVersion. Не выдумывай ответы кандидата.`;

/** System prompt used when a real conversation transcript is supplied. */
const SYSTEM_WITH_TRANSCRIPT = `Ты HR-аналитик. На входе — карточка интервью И полный транскрипт реальной беседы кандидата с AI HR-агентом.

Анализируй ОТВЕТЫ кандидата (не агента), оценивай факты только из транскрипта, не выдумывай детали которых не было в диалоге.

Верни один JSON-объект (без markdown) со строго такими ключами:
- verdict: "strong_fit" | "maybe" | "no_fit" — на основе фактических ответов и соответствия JD.
- confidence: "low" | "medium" | "high" — насколько уверенно можно судить из этого разговора (короткие/уклончивые ответы → low).
- roleFit: одна строка по-русски: позиция + компания + кандидат + 1–2 предложения о фактическом соответствии.
- strengths: массив строк — сильные стороны кандидата ПОДТВЕРЖДЁННЫЕ ответами в транскрипте (с краткой ссылкой "по ответу про X").
- gaps: массив строк — где у кандидата явные пробелы или уход от ответа (с указанием темы).
- weaknesses: массив строк — слабости в формулировках, аргументации или опыте.
- risks: массив строк — реальные риски найма из услышанного (если нечего — []).
- redFlags: массив строк — явные red flags из ответов кандидата (если нечего — []).
- salaryExpectations: одна строка с зарплатными ожиданиями если кандидат их озвучил, иначе пропусти ключ.
- relocationTravel: одна строка о готовности к релокации/командировкам если обсуждалось, иначе пропусти ключ.
- recommendedNextStep: одна строка — практичный следующий шаг для HR на основе фактов разговора.
- hiringRecommendation: "hire" | "maybe" | "reject" — финальная рекомендация HR-команде.
- scores: объект { communication: 1-10, motivation: 1-10, experience: 1-10, problemSolving: 1-10, cultureFit: 1-10 } — оценки строго на основании ответов; ставь null для измерения если оно не звучало в диалоге.
- questionCoverage: массив { order: number, status: "discussed" | "partially_discussed" | "not_discussed", note: string } по каждому вопросу из списка, в исходном порядке.
- notes: кратко по-русски: качество транскрипта, длина разговора, явные ограничения анализа.

НЕ включай в JSON поля summarySchemaVersion. Если транскрипт обрезан/неполный — отметь это в notes и снижай confidence.`;

type TranscriptTurn = { role: "agent" | "candidate"; text: string; ts: number };

function isTranscriptArray(value: unknown): value is TranscriptTurn[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      ((entry as Partial<TranscriptTurn>).role === "agent" ||
        (entry as Partial<TranscriptTurn>).role === "candidate") &&
      typeof (entry as Partial<TranscriptTurn>).text === "string"
  );
}

function renderTranscript(transcript: TranscriptTurn[]): string {
  if (!transcript.length) return "";
  const startTs = transcript[0]!.ts;
  return transcript
    .map((turn) => {
      const offsetSec = Math.max(0, Math.round((turn.ts - startTs) / 1000));
      const mm = String(Math.floor(offsetSec / 60)).padStart(2, "0");
      const ss = String(offsetSec % 60).padStart(2, "0");
      const speaker = turn.role === "agent" ? "HR" : "Кандидат";
      return `[${mm}:${ss}] ${speaker}: ${turn.text.trim()}`;
    })
    .join("\n");
}

function buildUserPayload(input: InterviewSummaryContextInput | null, transcript?: TranscriptTurn[]) {
  const name =
    input?.candidateFullName?.trim() ||
    [input?.candidateFirstName?.trim(), input?.candidateLastName?.trim()].filter(Boolean).join(" ").trim() ||
    "кандидат";
  const { text: vacancyExcerpt } = truncateVacancyForContext(input?.vacancyText, 10_000);
  const questions = (input?.questions ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((q) => ({ order: q.order, text: (q.text ?? "").trim() }));

  const card = JSON.stringify(
    {
      candidate: name,
      company: input?.companyName?.trim() ?? "",
      jobTitle: input?.jobTitle?.trim() ?? "",
      specialty: input?.specialtyName?.trim() ?? "",
      vacancyExcerpt,
      questions
    },
    null,
    0
  );

  if (!transcript || transcript.length === 0) {
    return `Карточка интервью:\n${card}`;
  }
  return `Карточка интервью:\n${card}\n\nТранскрипт диалога (timestamps от старта сессии):\n${renderTranscript(transcript)}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let input: InterviewSummaryContextInput | null = null;
  try {
    const raw = (await request.json()) as InterviewSummaryContextInput | { context?: InterviewSummaryContextInput };
    input = "context" in raw && raw.context ? raw.context : (raw as InterviewSummaryContextInput);
  } catch {
    return NextResponse.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  const baseline = buildInterviewSummaryPayload(input);
  const transcript = isTranscriptArray(input?.transcript) ? input!.transcript : undefined;
  const hasTranscript = Boolean(transcript && transcript.length > 0);

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({
      message: "OPENAI_API_KEY is not set; returned deterministic baseline.",
      summary: baseline,
      skipped: true,
      transcriptTurns: transcript?.length ?? 0
    });
  }

  const model = (process.env.INTERVIEW_SUMMARY_OPENAI_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const system = hasTranscript ? SYSTEM_WITH_TRANSCRIPT : SYSTEM_NO_TRANSCRIPT;

  try {
    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: hasTranscript ? 0.2 : 0.35,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `Проанализируй и верни только JSON по схеме.\n${buildUserPayload(input, transcript)}`
          }
        ]
      })
    });

    if (!completion.ok) {
      const errText = await completion.text().catch(() => "");
      return NextResponse.json(
        {
          message: `OpenAI error ${completion.status}`,
          detail: errText.slice(0, 500),
          summary: baseline,
          model
        },
        { status: 200 }
      );
    }

    const payload = (await completion.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return NextResponse.json({ summary: baseline, model, warning: "empty_completion" });
    }

    let draft: unknown;
    try {
      draft = JSON.parse(content) as unknown;
    } catch {
      return NextResponse.json({ summary: baseline, model, warning: "invalid_json" });
    }

    const merged = mergeInterviewSummaryAiDraft(baseline, draft, { model });
    if (hasTranscript) {
      // With a real transcript the AI fills scores / questionCoverage / hire — no
      // longer "evaluation pending". Drop the placeholder so the UI stops showing
      // the orange badge that says "human review required".
      delete (merged as { evaluationPending?: boolean }).evaluationPending;
    }
    return NextResponse.json({ summary: merged, model, transcriptTurns: transcript?.length ?? 0 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "OpenAI request failed";
    return NextResponse.json({ message, summary: baseline, model }, { status: 200 });
  }
}
