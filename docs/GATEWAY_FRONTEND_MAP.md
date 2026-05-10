# Gateway HTTP paths → frontend callers

Browser code should use **`/api/gateway/...`** (Next proxy with allowlist in [`app/api/gateway/[...path]/route.ts`](../app/api/gateway/[...path]/route.ts)). Server routes may call `BACKEND_GATEWAY_URL` directly (e.g. [`app/api/stream/token/route.ts`](../app/api/stream/token/route.ts)).

Legend: **lib** = [`lib/api.ts`](../lib/api.ts) via `requestJson` / helpers unless noted.

| Gateway path (relative to proxy) | Method | Caller |
|----------------------------------|--------|--------|
| `realtime/token` | GET | `getRealtimeToken()` (`lib/api.ts`) |
| `realtime/session` | POST (SDP body) | `createRealtimeSession()` (`lib/api.ts`) |
| `realtime/session/:sessionId/events` | POST | `sendRealtimeEvent()` (`lib/api.ts`) |
| `realtime/session/:sessionId` | GET | `getRealtimeSessionState()` (`lib/api.ts`) |
| `realtime/session/:sessionId` | DELETE | `closeRealtimeSession()` (`lib/api.ts`) |
| `runtime/:meetingId` | GET | `getRuntimeSnapshot()` (`lib/api.ts`) |
| `runtime/by-interview/:jobAiId` | GET | `getRuntimeSnapshotByInterview()` (`lib/api.ts`) |
| `runtime/:meetingId/commands` | POST | `issueRuntimeCommand()` (`lib/api.ts`) |
| `runtime/:meetingId/events` | GET / POST | `use-interview-session.ts` (SSE/poll), `observer-stream-card.tsx` |
| `runtime/:meetingId/stream` | GET (SSE) | `app/spectator/page.tsx` |
| `meetings/start` | POST | `startMeeting()` (`lib/api.ts`) |
| `meetings/:id/stop` | POST | `stopMeeting()` (`lib/api.ts`) |
| `meetings/:id/fail` | POST | `failMeeting()` (`lib/api.ts`) |
| `meetings/:id` | GET | `getMeetingDetail()` (`lib/api.ts`) |
| `meetings` | GET | `listMeetingsSnapshot()` (`lib/api.ts`) |
| `meetings/:id/recording` | GET | `getMeetingRecording()` (`lib/api.ts`) |
| `meetings/:id/recording/start` | POST | `startMeetingRecording()` (`lib/api.ts`) |
| `meetings/:id/recording/stop` | POST | `stopMeetingRecording()` (`lib/api.ts`) |
| `meetings/:id/recording/download` | GET | `getMeetingRecordingDownload()` (`lib/api.ts`) |
| `meetings/:id/recording/sync-jobai` | POST | `syncMeetingRecordingToJobAi()` (`lib/api.ts`) |
| `meetings/:id/openai/voice` | POST | `setMeetingOpenAiRealtimeVoice()` (`lib/api.ts`) |
| `meetings/:id/admission/candidate` | GET | `getCandidateAdmissionStatus()` (`lib/api.ts`) |
| `meetings/:id/admission/candidate/decision` | POST | `decideCandidateAdmission()` (`lib/api.ts`) |
| `meetings/:id/admission/candidate/release` | POST | `releaseCandidateAdmission()` (`lib/api.ts`) |
| `meetings/:id/admission/candidate/acquire` | POST | **Server only** — `app/api/stream/token/route.ts` → gateway |
| `interviews` | GET | `listInterviews()` (`lib/api.ts`) |
| `interviews/:id` | GET | `getInterviewById()` (`lib/api.ts`) |
| `interviews/:id/prototype-candidate-fio` | POST | `savePrototypeCandidateFio()` (`lib/api.ts`) |
| `interviews/:id/session-link` | POST | `linkInterviewSession()` (`lib/api.ts`) |
| `interviews/:id/status` | POST | `updateInterviewStatus()` (`lib/api.ts`) |
| `interviews/source/status` | GET | `getJobAiSourceStatus()` (`lib/api.ts`) |
| `interviews/:id/links/candidate` | POST | `issueCandidateJoinLink()` (`lib/api.ts`) |
| `interviews/:id/links/spectator` | POST | `issueSpectatorJoinLink()` (`lib/api.ts`) |
| `interviews/:id/links/revoke` | POST | `revokeJoinLink()` (`lib/api.ts`) |
| `interviews/:id/links/audit` | GET | `listJoinLinkAudit()` (`lib/api.ts`) |
| `join/spectator/:token/session-ticket` | POST | `app/spectator/page.tsx`, `observer-stream-card.tsx` |
| `api/v1/questions/general` | GET | `getRuntimePromptSettingsSoft()` (`lib/api.ts`) |

## Not proxied from the browser

Paths under `avatar`, `livekit`, `health`, `metrics`, raw `jobai` ingest, etc. are **not** in the Next allowlist — see [`INTEGRATION_AVATAR_AND_RUNTIME.md`](./INTEGRATION_AVATAR_AND_RUNTIME.md) and gateway `app.ts` on the backend repo.
