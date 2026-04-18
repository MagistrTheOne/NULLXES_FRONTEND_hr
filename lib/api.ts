export type SessionTokenResponse = {
  sessionId: string;
  token: string;
  expiresAt?: number;
  session: Record<string, unknown>;
};

export type RealtimeSessionState = {
  session: {
    id: string;
    status: "starting" | "active" | "closing" | "closed" | "error";
    createdAt: number;
    updatedAt: number;
    lastActivityAt: number;
    closedAt?: number;
    remoteCallId?: string;
    lastError?: string;
    eventCount: number;
    eventTypeCounts: Record<string, number>;
  };
};

export type StartMeetingInput = {
  internalMeetingId: string;
  triggerSource: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
};

export type StopMeetingInput = {
  reason: "manual_stop" | "superseded_by_other_meeting" | "error";
  finalStatus?: "stopped_during_meeting" | "completed";
  metadata?: Record<string, unknown>;
};

export type FailMeetingInput = {
  status: "failed_audio_pool_busy" | "failed_connect_ws_audio";
  reason: string;
  metadata?: Record<string, unknown>;
};

export type JobAiInterviewStatus =
  | "pending"
  | "received"
  | "in_meeting"
  | "completed"
  | "stopped_during_meeting"
  | "canceled"
  | "meeting_not_started";

export type NullxesRuntimeStatus = "idle" | "in_meeting" | "completed" | "stopped_during_meeting" | "failed";

export type NullxesBusinessKey =
  | "awaiting_registration"
  | "accepted_by_ai"
  | "meeting_in_progress"
  | "canceled"
  | "stopped_mid_meeting"
  | "completed"
  | "start_error";

export type InterviewListRow = {
  jobAiId: number;
  nullxesMeetingId?: string;
  sessionId?: string;
  candidateFirstName: string;
  candidateLastName: string;
  candidateEntryPath: string;
  spectatorEntryPath: string;
  nullxesBusinessKey: NullxesBusinessKey;
  nullxesBusinessLabel: string;
  companyName: string;
  meetingAt: string;
  jobAiStatus: JobAiInterviewStatus;
  nullxesStatus: NullxesRuntimeStatus;
  updatedAt: string;
  statusChangedAt?: string;
  createdAt: string;
  greetingSpeechResolved?: string;
  finalSpeechResolved?: string;
};

export type PrototypeCandidatePayload = {
  candidateFirstName: string;
  candidateLastName: string;
  sourceFullName: string;
  updatedAt: string;
};

export type InterviewDetail = {
  interview: Record<string, unknown> & {
    id: number;
    jobTitle: string;
    vacancyText?: string;
    status: JobAiInterviewStatus;
    candidateFirstName: string;
    candidateLastName: string;
    companyName: string;
    meetingAt: string;
    greetingSpeech?: string;
    finalSpeech?: string;
    greetingSpeechResolved?: string;
    finalSpeechResolved?: string;
    specialty?: {
      id: number;
      name: string;
      questions?: Array<{ text: string; order: number }>;
    };
  };
  projection: InterviewListRow;
  /** ФИО из прототипа, сохранённые на gateway (raw JobAI не меняются). */
  prototypeCandidate?: PrototypeCandidatePayload | null;
};

export type JobAiSourceStatus = {
  endpoints: Array<{ endpoint: string; status: "active" | "queued" | "disabled" }>;
  sync: {
    lastSyncAt: string | null;
    lastSyncResult: "idle" | "success" | "error";
    lastSyncError: string | null;
    storedCount: number;
  };
};

export type CandidateAdmissionParticipant = {
  participantId: string;
  displayName: string;
  acquiredAt: number;
  lastSeenAt: number;
};

export type CandidateAdmissionPending = {
  participantId: string;
  displayName: string;
  requestedAt: number;
  lastSeenAt: number;
};

export type CandidateAdmissionStatus = {
  meetingId: string;
  rejoinWindowMs: number;
  owner: CandidateAdmissionParticipant | null;
  ownerActive: boolean;
  pending: CandidateAdmissionPending[];
  canCurrentParticipantRejoin: boolean;
};

type JsonRecord = Record<string, unknown>;

export type ApiRequestErrorCode = "timeout" | "network" | "http" | "invalid_json";

export class ApiRequestError extends Error {
  readonly code: ApiRequestErrorCode;
  readonly status?: number;
  readonly retriable: boolean;

  constructor(options: { message: string; code: ApiRequestErrorCode; status?: number; retriable?: boolean }) {
    super(options.message);
    this.name = "ApiRequestError";
    this.code = options.code;
    this.status = options.status;
    this.retriable = Boolean(options.retriable);
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

type RequestJsonOptions = RequestInit & {
  timeoutMs?: number;
};

type RetryPolicy = {
  attempts: number;
  delayMs: number;
  timeoutMs: number;
};

const DEFAULT_CRITICAL_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  delayMs: 400,
  timeoutMs: 12000
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs?: number): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(input, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiRequestError({
        message: `Request timed out after ${timeoutMs}ms`,
        code: "timeout",
        retriable: true
      });
    }
    if (error instanceof TypeError) {
      throw new ApiRequestError({
        message: "Network request failed",
        code: "network",
        retriable: true
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson<T>(path: string, init?: RequestJsonOptions): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `/api/gateway/${path}`,
      {
        ...init,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers ?? {})
        }
      },
      init?.timeoutMs
    );
  } catch (error) {
    if (isApiRequestError(error)) {
      throw error;
    }
    throw new ApiRequestError({
      message: error instanceof Error ? error.message : "Network request failed",
      code: "network",
      retriable: true
    });
  }

  const raw = await response.text();
  let payload: JsonRecord = {};
  if (raw) {
    try {
      payload = JSON.parse(raw) as JsonRecord;
    } catch {
      if (!response.ok) {
        throw new ApiRequestError({
          message: `Request failed (${response.status})`,
          code: "http",
          status: response.status,
          retriable: response.status >= 500
        });
      }
      throw new ApiRequestError({
        message: "Invalid JSON response from gateway",
        code: "invalid_json",
        retriable: false
      });
    }
  }

  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : response.statusText || `Request failed (${response.status})`;
    throw new ApiRequestError({
      message,
      code: "http",
      status: response.status,
      retriable: response.status >= 500 || response.status === 429
    });
  }

  return payload as T;
}

async function requestJsonWithRetry<T>(
  path: string,
  init: RequestInit,
  policy: RetryPolicy = DEFAULT_CRITICAL_RETRY_POLICY
): Promise<T> {
  const attempts = Math.max(1, policy.attempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJson<T>(path, {
        ...init,
        timeoutMs: policy.timeoutMs
      });
    } catch (error) {
      lastError = error;
      const retriable = isApiRequestError(error) ? error.retriable : false;
      if (!retriable || attempt >= attempts) {
        throw error;
      }
      await sleep(policy.delayMs * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Request failed");
}

export async function getRealtimeToken(): Promise<SessionTokenResponse> {
  return requestJson<SessionTokenResponse>("realtime/token", { method: "GET" });
}

export async function createRealtimeSession(offerSdp: string): Promise<{ answerSdp: string; sessionId?: string }> {
  const response = await fetch("/api/gateway/realtime/session", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/sdp"
    },
    body: offerSdp
  });

  const answerSdp = await response.text();
  if (!response.ok) {
    try {
      const json = JSON.parse(answerSdp) as JsonRecord;
      throw new Error(typeof json.message === "string" ? json.message : "Realtime session failed");
    } catch {
      throw new Error("Realtime session failed");
    }
  }

  return {
    answerSdp,
    sessionId: response.headers.get("x-session-id") ?? undefined
  };
}

export async function sendRealtimeEvent(
  sessionId: string,
  payload: Record<string, unknown>
): Promise<{ status: string; eventType?: string }> {
  return requestJson<{ status: string; eventType?: string }>(`realtime/session/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function getRealtimeSessionState(sessionId: string): Promise<RealtimeSessionState> {
  return requestJson<RealtimeSessionState>(`realtime/session/${sessionId}`, { method: "GET" });
}

export async function closeRealtimeSession(sessionId: string): Promise<void> {
  await fetch(`/api/gateway/realtime/session/${sessionId}`, {
    method: "DELETE",
    credentials: "include"
  });
}

export async function startMeeting(input: StartMeetingInput): Promise<JsonRecord> {
  return requestJsonWithRetry<JsonRecord>("meetings/start", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function stopMeeting(meetingId: string, input: StopMeetingInput): Promise<JsonRecord> {
  return requestJsonWithRetry<JsonRecord>(`meetings/${meetingId}/stop`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export type MeetingDetailResponse = {
  meeting: {
    meetingId: string;
    status: string;
    metadata?: Record<string, unknown>;
    sessionId?: string | null;
    schemaVersion?: string;
    [key: string]: unknown;
  };
  history: unknown[];
};

export async function getMeetingDetail(meetingId: string): Promise<MeetingDetailResponse> {
  return requestJson<MeetingDetailResponse>(`meetings/${encodeURIComponent(meetingId)}`, {
    method: "GET"
  });
}

export async function failMeeting(meetingId: string, input: FailMeetingInput): Promise<JsonRecord> {
  return requestJson<JsonRecord>(`meetings/${meetingId}/fail`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function listInterviews(params?: { skip?: number; take?: number; sync?: boolean }): Promise<{
  interviews: InterviewListRow[];
  count: number;
}> {
  const skip = params?.skip ?? 0;
  const take = params?.take ?? 20;
  const sync = params?.sync ? "&sync=1" : "";
  return requestJson<{ interviews: InterviewListRow[]; count: number }>(`interviews?skip=${skip}&take=${take}${sync}`, {
    method: "GET"
  });
}

export async function getInterviewById(id: number, sync = false): Promise<InterviewDetail> {
  const suffix = sync ? "?sync=1" : "";
  return requestJson<InterviewDetail>(`interviews/${id}${suffix}`, { method: "GET" });
}

/** Сохранить ФИО кандидата в проекции gateway (разбор: первая лексема → фамилия, остальное → имя+отчество). */
export async function savePrototypeCandidateFio(jobAiId: number, fullName: string): Promise<InterviewDetail> {
  return requestJson<InterviewDetail>(`interviews/${jobAiId}/prototype-candidate-fio`, {
    method: "POST",
    body: JSON.stringify({ fullName })
  });
}

export async function linkInterviewSession(input: {
  interviewId: number;
  meetingId: string;
  sessionId?: string;
  nullxesStatus?: InterviewListRow["nullxesStatus"];
}): Promise<InterviewDetail> {
  return requestJsonWithRetry<InterviewDetail>(`interviews/${input.interviewId}/session-link`, {
    method: "POST",
    body: JSON.stringify({
      meetingId: input.meetingId,
      sessionId: input.sessionId,
      nullxesStatus: input.nullxesStatus
    })
  });
}

function postJobAiIngestNotification(id: number, status: string): void {
  if (typeof window === "undefined") {
    return;
  }
  void fetch("/api/jobai/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status }),
    credentials: "same-origin",
  }).catch(() => {});
}

export async function updateInterviewStatus(id: number, status: JobAiInterviewStatus): Promise<InterviewDetail> {
  const detail = await requestJsonWithRetry<InterviewDetail>(`interviews/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  postJobAiIngestNotification(id, status);
  return detail;
}

export async function getJobAiSourceStatus(): Promise<JobAiSourceStatus> {
  return requestJson<JobAiSourceStatus>("interviews/source/status", { method: "GET" });
}

export async function getCandidateAdmissionStatus(
  meetingId: string,
  participantId?: string
): Promise<CandidateAdmissionStatus> {
  const suffix = participantId ? `?participantId=${encodeURIComponent(participantId)}` : "";
  return requestJson<CandidateAdmissionStatus>(`meetings/${meetingId}/admission/candidate${suffix}`, { method: "GET" });
}

export async function decideCandidateAdmission(
  meetingId: string,
  input: { participantId: string; action: "approve" | "deny"; decidedBy?: string }
): Promise<{ action: "approve" | "deny"; granted: boolean; owner: CandidateAdmissionParticipant | null; pending: CandidateAdmissionPending[] }> {
  return requestJsonWithRetry(`meetings/${meetingId}/admission/candidate/decision`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function releaseCandidateAdmission(
  meetingId: string,
  input: { participantId: string; reason?: string }
): Promise<{ released: boolean; owner: CandidateAdmissionParticipant | null; pending: CandidateAdmissionPending[] }> {
  return requestJsonWithRetry(`meetings/${meetingId}/admission/candidate/release`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}
