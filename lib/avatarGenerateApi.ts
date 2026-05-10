export type AvatarGenerateJobState = "queued" | "processing" | "hydrating" | "completed" | "failed";

export type AvatarGenerateJob = {
  id: string;
  state: AvatarGenerateJobState;
  createdAtMs: number;
  updatedAtMs: number;
  startedAt?: string;
  processingStartedAt?: string;
  completedAt?: string;
  failedAt?: string;
  retryCount?: number;
  prompt: string;
  errorMessage?: string;
  /** Absolute public URL (gateway builds from GPU worker base + result[0]). */
  videoUrl?: string;
  /** @deprecated use videoUrl */
  resultVideoUrl?: string;
  resultPayload?: unknown;
};

/** GET /avatar/health — stable production shape (no raw worker URLs). */
export type AvatarHealthResponse = {
  gpuReachable: boolean;
  redisReachable: boolean;
  streamConfigured: boolean;
  runtimeLatencyMs: number | null;
  lastSuccessfulGenerationAt: string | null;
};

export async function fetchAvatarHealth(): Promise<AvatarHealthResponse> {
  const res = await fetch("/api/gateway/avatar/health", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`health ${res.status}`);
  }
  return (await res.json()) as AvatarHealthResponse;
}

export async function postAvatarGenerate(form: FormData): Promise<{ jobId: string; state: string }> {
  const res = await fetch("/api/gateway/avatar/generate", {
    method: "POST",
    body: form
  });
  const payload = (await res.json().catch(() => ({}))) as { message?: string; jobId?: string; state?: string };
  if (!res.ok) {
    throw new Error(payload.message ?? `generate failed (${res.status})`);
  }
  if (!payload.jobId) {
    throw new Error("missing jobId in response");
  }
  return { jobId: payload.jobId, state: payload.state ?? "queued" };
}

export async function fetchAvatarJob(jobId: string): Promise<{ job: AvatarGenerateJob }> {
  const res = await fetch(`/api/gateway/avatar/job/${encodeURIComponent(jobId)}`, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `job ${res.status}`);
  }
  return (await res.json()) as { job: AvatarGenerateJob };
}
