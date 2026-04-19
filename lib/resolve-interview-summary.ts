import type { InterviewStartContext } from "@/lib/interview-start-context";
import { buildInterviewSummaryPayload, type InterviewSummaryPayload } from "@/lib/interview-summary";

export type SummaryTranscriptTurn = { role: "agent" | "candidate"; text: string; ts: number };

/**
 * Итог интервью: детерминированный baseline + при наличии OPENAI_API_KEY на сервере — черновик gpt-4o (см. /api/interview/summary).
 *
 * Если передан `transcript` (последовательность реплик агента/кандидата за время сессии),
 * сервер использует его в системном промпте и заполняет `questionCoverage` / `scores` /
 * `hiringRecommendation` на основе реальных ответов кандидата вместо baseline-only анализа.
 */
export async function resolveInterviewSummaryPayload(
  input: InterviewStartContext | null,
  transcript?: SummaryTranscriptTurn[]
): Promise<InterviewSummaryPayload> {
  const baseline = buildInterviewSummaryPayload(input);
  const body =
    transcript && transcript.length > 0
      ? { ...(input ?? {}), transcript }
      : (input ?? {});
  try {
    const res = await fetch("/api/interview/summary", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      return baseline;
    }
    const data = (await res.json()) as { summary?: InterviewSummaryPayload };
    if (data.summary?.summarySchemaVersion === baseline.summarySchemaVersion) {
      return data.summary;
    }
  } catch {
    /* сеть / парсинг — оставляем baseline */
  }
  return baseline;
}
