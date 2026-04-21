import type { InterviewStartContext } from "@/lib/interview-start-context";
import { buildInterviewSummaryPayload, type InterviewSummaryPayload } from "@/lib/interview-summary";

export type SummaryTranscriptTurn = { role: "agent" | "candidate"; text: string; ts: number };
export type AiSummaryMode = "real" | "fallback";
export type ResolvedInterviewSummary = {
  summary: InterviewSummaryPayload;
  aiSummaryMode: AiSummaryMode;
  warning?: string;
  fallbackReason?: string;
  correlationId?: string;
  status: number;
};

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
): Promise<ResolvedInterviewSummary> {
  const baseline = buildInterviewSummaryPayload(input);
  const body =
    transcript && transcript.length > 0
      ? { ...(input ?? {}), transcript }
      : (input ?? {});
  const fallback = (status = 200): ResolvedInterviewSummary => ({
    summary: baseline,
    aiSummaryMode: "fallback",
    warning: "summary_fallback_client_default",
    fallbackReason: "client_default_fallback",
    status
  });
  try {
    const res = await fetch("/api/interview/summary", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = (await res.json()) as {
      summary?: InterviewSummaryPayload;
      ai_summary_mode?: AiSummaryMode;
      warning?: string;
      fallbackReason?: string;
      correlationId?: string;
    };

    const summary =
      data.summary?.summarySchemaVersion === baseline.summarySchemaVersion
        ? data.summary
        : baseline;
    if (!res.ok) {
      return {
        summary,
        aiSummaryMode: "fallback",
        warning: data.warning ?? "summary_fallback_http_error",
        fallbackReason: data.fallbackReason ?? "summary_http_error",
        correlationId: data.correlationId,
        status: res.status
      };
    }

    const mode = data.ai_summary_mode ?? "fallback";
    return {
      summary,
      aiSummaryMode: mode,
      warning: data.warning,
      fallbackReason: data.fallbackReason,
      correlationId: data.correlationId,
      status: res.status
    };
  } catch {
    /* сеть / парсинг — оставляем baseline */
    return fallback(0);
  }
}
