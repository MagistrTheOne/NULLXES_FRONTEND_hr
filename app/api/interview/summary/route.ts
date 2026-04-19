import { NextRequest, NextResponse } from "next/server";
import {
  buildInterviewSummaryPayload,
  mergeInterviewSummaryAiDraft,
  truncateVacancyForContext,
  type InterviewSummaryContextInput
} from "@/lib/interview-summary";

export const runtime = "nodejs";

const DEFAULT_MODEL = "gpt-4o";

/**
 * NULLXES HR analyst prompt (v2). Решение всегда обязательно — никаких
 * "scores pending", "недостаточно данных", "нужно прослушать запись".
 *
 * При отсутствии транскрипта оценка консервативная (5/10 по умолчанию,
 * confidencePercent низкий), но decision и scores выставляются всегда.
 */
const SYSTEM_BASE = `Ты — senior HR-аналитик и интервьюер платформы NULLXES JobAI. Принимаешь решение по кандидату на основе доступных данных. Никогда не перекладываешь решение на человека, не пишешь "нужно прослушать запись" или "невозможно оценить" — даже при минимальных данных делаешь обоснованную консервативную оценку.

Оцени кандидата по 4 шкалам 1–10:
- experience: релевантность опыта требованиям вакансии
- communication: качество и ясность речи, структура ответов
- thinking: глубина аргументации, способность думать в диалоге
- objections: работа с возражениями, поведение в стрессовых вопросах

Итоговый балл вычисляется автоматически по формуле 0.3·experience + 0.25·communication + 0.25·thinking + 0.2·objections, его в JSON НЕ возвращай.

Реши decision по порогам:
- score ≥ 7.5 → "recommended"
- 5.5 ≤ score < 7.5 → "consider"
- score < 5.5 → "rejected"

Уровень confidencePercent (0..100): зависит от полноты ответов, согласованности и глубины аргументации. Без транскрипта confidencePercent ≤ 40.

Верни СТРОГО JSON (без markdown) со следующими полями:
{
  "decision": "recommended" | "consider" | "rejected",
  "confidencePercent": <integer 0-100>,
  "scores4": {
    "experience": <1-10>,
    "communication": <1-10>,
    "thinking": <1-10>,
    "objections": <1-10>
  },
  "keyFindings": [<2-3 коротких предложения по-русски, без воды, что определило решение>],
  "risks": [<если есть — список конкретных рисков найма; если нет — []>],
  "recommendedNextStep": "<одна строка: финальное интервью / уточняющее интервью / тестовое задание / отказ>"
}

ЗАПРЕТЫ:
- НЕ используй слова "возможно", "вероятно", "скорее всего", "scores pending", "evaluation pending".
- НЕ перекладывай решение на HR ("нужно прослушать", "требуется ручной разбор").
- НЕ возвращай null/undefined в scores4 — всегда числа 1..10.
- НЕ добавляй лишних полей вне схемы.
- Все тексты строго на русском, деловой стиль, без англицизмов (hire/reject/maybe и т.п.).`;

const SYSTEM_NO_TRANSCRIPT = `${SYSTEM_BASE}

ВХОДНЫЕ ДАННЫЕ ОГРАНИЧЕНЫ: только карточка интервью без транскрипта диалога.
Без транскрипта ставь scores4 консервативно (около 5/10 по каждой шкале), confidencePercent в диапазоне 15..40, decision как правило "consider". Если в JD есть явные требования которым кандидат явно не подходит — можно "rejected".`;

const SYSTEM_WITH_TRANSCRIPT = `${SYSTEM_BASE}

ВХОДНЫЕ ДАННЫЕ ВКЛЮЧАЮТ ПОЛНЫЙ ТРАНСКРИПТ диалога кандидата с AI HR-агентом. Анализируй ОТВЕТЫ кандидата (реплики "Кандидат:" в транскрипте), не приписывай ему слова агента.
Оцени scores4 строго по фактам из транскрипта. Короткие/уклончивые ответы снижают communication и thinking. Если кандидат явно противоречит требованиям JD — снижай experience. Если уходит от вопросов или паникует — снижай objections.
confidencePercent зависит от длины и качества транскрипта: < 5 реплик кандидата → ≤ 40, 5–15 реплик → 40–70, > 15 содержательных реплик → 70–95.
В keyFindings ссылайся на конкретные темы из транскрипта ("по ответу про X — ...").`;

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
    return NextResponse.json({ summary: merged, model, transcriptTurns: transcript?.length ?? 0 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "OpenAI request failed";
    return NextResponse.json({ message, summary: baseline, model }, { status: 200 });
  }
}
