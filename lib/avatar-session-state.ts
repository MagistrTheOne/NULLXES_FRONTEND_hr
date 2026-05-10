import type { AvatarGenerateJob } from "@/lib/avatarGenerateApi";

/**
 * Client-side orchestration state for avatar generation / future realtime streaming.
 * Maps backend job states into UX phases including warmup.
 */
export type AvatarSessionState =
  | "idle"
  | "uploading"
  | "queued"
  | "initializing"
  | "processing"
  | "hydrating"
  | "completed"
  | "failed";

/** Snapshot for UI + future WebSocket adapter (same shape as poll tick). */
export type AvatarJobSnapshot = Pick<
  AvatarGenerateJob,
  | "id"
  | "state"
  | "createdAtMs"
  | "updatedAtMs"
  | "videoUrl"
  | "resultVideoUrl"
  | "errorMessage"
  | "completedAt"
  | "startedAt"
  | "processingStartedAt"
  | "failedAt"
  | "retryCount"
>;

/**
 * Future: replace polling with push updates while keeping `AvatarSessionState` derivation.
 * Implementations may use WebSocket, SSE, or ably — UI stays on snapshots + session FSM.
 */
export type AvatarSessionTransport = {
  subscribe(jobId: string, onSnapshot: (snap: AvatarJobSnapshot) => void): () => void;
};

export const AVATAR_WARMUP_LOG_LINES = [
  "Connecting neural stream...",
  "Loading behavioral profile...",
  "Synchronizing voice model...",
  "Preparing facial animation..."
] as const;

const RUNPOD_URL_PATTERN = /(?:https?:\/\/)?[\w.-]*runpod\.net[^\s]*/gi;

/** Never show external GPU hostnames in user-facing copy. */
export function sanitizeAvatarUserMessage(raw: string): string {
  const s = raw.replace(RUNPOD_URL_PATTERN, "[GPU worker]");
  return s.trim() || "Request failed";
}

export function pickAvatarVideoUrl(job: AvatarJobSnapshot | null): string | undefined {
  if (!job) return undefined;
  return job.videoUrl ?? job.resultVideoUrl;
}
