import { NextRequest, NextResponse } from "next/server";
import {
  buildInterviewSummaryPayload,
  mergeInterviewSummaryAiDraft,
  truncateVacancyForContext,
  type InterviewSummaryContextInput
} from "@/lib/interview-summary";

export const runtime = "nodejs";

const DEFAULT_MODEL = "gpt-4o";

const SYSTEM = `Ты HR-аналитик. На входе — только карточка интервью: кандидат, компания, должность, фрагмент вакансии, список вопросов (с order). Транскрипта диалога НЕТ.

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

function buildUserPayload(input: InterviewSummaryContextInput | null) {
  const name =
    input?.candidateFullName?.trim() ||
    [input?.candidateFirstName?.trim(), input?.candidateLastName?.trim()].filter(Boolean).join(" ").trim() ||
    "кандидат";
  const { text: vacancyExcerpt } = truncateVacancyForContext(input?.vacancyText, 10_000);
  const questions = (input?.questions ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((q) => ({ order: q.order, text: (q.text ?? "").trim() }));

  return JSON.stringify(
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

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({
      message: "OPENAI_API_KEY is not set; returned deterministic baseline.",
      summary: baseline,
      skipped: true
    });
  }

  const model = (process.env.INTERVIEW_SUMMARY_OPENAI_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  try {
    const completion = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Проанализируй и верни только JSON по схеме:\n${buildUserPayload(input)}` }
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
    return NextResponse.json({ summary: merged, model });
  } catch (e) {
    const message = e instanceof Error ? e.message : "OpenAI request failed";
    return NextResponse.json({ message, summary: baseline, model }, { status: 200 });
  }
}
