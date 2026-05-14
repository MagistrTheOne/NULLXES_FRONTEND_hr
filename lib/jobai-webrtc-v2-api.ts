/**
 * ЧТЗ WebRTC–JobAI п.1.2 / 1.3 / 1.4 / 1.5 — клиент к realtime-gateway через `/api/gateway/*`.
 * Таймауты по п.4.1: 1.2 → 30s, 1.5 → 35s, 1.3 → 15s.
 */

import { ApiRequestError, isApiRequestError } from "./api";

const GW_PREFIX = "/api/gateway";

async function fetchGatewayJson<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GW_PREFIX}/${path}`, {
      ...init,
      credentials: "include",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });
    const raw = await res.text();
    let payload: Record<string, unknown> = {};
    if (raw) {
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        if (!res.ok) {
          throw new ApiRequestError({
            message: `Gateway error ${res.status}`,
            code: "http",
            status: res.status,
            retriable: res.status >= 500
          });
        }
        throw new ApiRequestError({
          message: "Invalid JSON from gateway",
          code: "invalid_json",
          retriable: false
        });
      }
    }
    if (!res.ok) {
      const message =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.errorCode === "string"
            ? payload.errorCode
            : res.statusText;
      throw new ApiRequestError({
        message,
        code: "http",
        status: res.status,
        retriable: res.status >= 500 || res.status === 429
      });
    }
    return payload as T;
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ApiRequestError({
        message: `Request timed out after ${timeoutMs}ms`,
        code: "timeout",
        retriable: true
      });
    }
    if (isApiRequestError(e)) throw e;
    throw new ApiRequestError({
      message: e instanceof Error ? e.message : "Network error",
      code: "network",
      retriable: true
    });
  } finally {
    clearTimeout(timer);
  }
}

export type LiveKitRoomPayload = {
  configured: boolean;
  roomName: string;
  serverUrl?: string;
  /** RTMP/ingress от контура JobAI (webhook), gateway только пробрасывает ключи. */
  ingress?: Record<string, string>;
  tokenPath?: string;
  controlWebSocketPath?: string;
  message?: string;
};

export type GetInterviewLivekitDataResponse = {
  role: string;
  candidate: { firstName: string; lastName: string; patronymic?: string | null };
  meetingAt: string;
  aiWSURL: string;
  companyName: string | null;
  questionsCount: number | null;
  meetingId: number;
  meetingControlKey: string;
  liveKitResponse: LiveKitRoomPayload;
};

export async function getInterviewLivekitData(inviteToken: string): Promise<GetInterviewLivekitDataResponse> {
  return fetchGatewayJson<GetInterviewLivekitDataResponse>("get-interview-livekit-data", {
    method: "POST",
    body: JSON.stringify({ inviteToken }),
    timeoutMs: 30_000
  });
}

export async function postMeetingPingStatus(
  meetingId: number,
  meetingControlKey: string
): Promise<{ status: "meeting_in_progress" | "meeting_stopped" }> {
  return fetchGatewayJson<{ status: "meeting_in_progress" | "meeting_stopped" }>("meeting/ping-status", {
    method: "POST",
    body: JSON.stringify({ meetingId }),
    headers: {
      Authorization: `Bearer ${meetingControlKey}`
    },
    timeoutMs: 30_000
  });
}

export type MeetingStartV2State = "meeting_started" | "meeting_already_started";

export async function postMeetingsStartV2(input: {
  meetingId: number;
  meetingControlKey: string;
  agentRTMPURL?: string;
}): Promise<{
  state: MeetingStartV2State;
  meetingId: string;
  numericMeetingId: number;
  status: string;
  agentReceiverRTMPURL?: string;
}> {
  return fetchGatewayJson("meetings/start", {
    method: "POST",
    body: JSON.stringify({
      meetingId: input.meetingId,
      ...(input.agentRTMPURL ? { agentRTMPURL: input.agentRTMPURL } : {})
    }),
    headers: {
      Authorization: `Bearer ${input.meetingControlKey}`
    },
    timeoutMs: 35_000
  });
}

export async function postDeinit(meetingId: number, meetingControlKey: string): Promise<void> {
  await fetchGatewayJson<Record<string, never>>("deinit", {
    method: "POST",
    body: JSON.stringify({ meetingId }),
    headers: {
      Authorization: `Bearer ${meetingControlKey}`
    },
    timeoutMs: 15_000
  });
}

export async function postLivekitToken(input: {
  meetingId: string;
  identity: string;
  name?: string;
}): Promise<{ serverUrl: string; token: string; room: string; identity: string }> {
  return fetchGatewayJson("livekit/token", {
    method: "POST",
    body: JSON.stringify({
      meetingId: input.meetingId,
      identity: input.identity,
      name: input.name ?? input.identity,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    }),
    timeoutMs: 30_000
  });
}
