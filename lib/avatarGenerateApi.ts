export type AvatarGenerateJobState = "queued" | "processing" | "completed" | "failed";

export type AvatarGenerateJob = {
  id: string;
  state: AvatarGenerateJobState;
  createdAtMs: number;
  updatedAtMs: number;
  prompt: string;
  errorMessage?: string;
  /** Absolute public URL (gateway builds from RunPod base + result[0]). */
  videoUrl?: string;
  /** ISO 8601 when job completed. */
  completedAt?: string;
  /** @deprecated use videoUrl */
  resultVideoUrl?: string;
  resultPayload?: unknown;
};

export type AvatarHealthResponse = {
  ok: boolean;
  runpod: { configured: boolean; baseUrl?: string; status?: number; detail?: string };
  redis: boolean;
  getstream: { configured: boolean };
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
