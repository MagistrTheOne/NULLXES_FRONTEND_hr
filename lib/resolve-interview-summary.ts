import type { InterviewStartContext } from "@/lib/interview-start-context";
import { buildInterviewSummaryPayload, type InterviewSummaryPayload } from "@/lib/interview-summary";

/**
 * Итог интервью: детерминированный baseline + при наличии OPENAI_API_KEY на сервере — черновик gpt-4o (см. /api/interview/summary).
 */
export async function resolveInterviewSummaryPayload(
  input: InterviewStartContext | null
): Promise<InterviewSummaryPayload> {
  const baseline = buildInterviewSummaryPayload(input);
  try {
    const res = await fetch("/api/interview/summary", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {})
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
