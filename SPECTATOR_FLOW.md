# Spectator Flow and Architecture

This document describes how spectator (observer) mode works in `frontend/jobaidemo`, including auth, Stream join behavior, and safety constraints.

## Purpose

Spectator is a read-only participant that can watch an active interview session without affecting candidate or HR flow.

Core goals:

- Observer never creates a new Stream room.
- Observer can join only an existing active call.
- Observer has limited backend command permissions.
- Candidate should not see observer controls or interaction effects.

## End-to-End Flow

1. Spectator opens signed link:
   - `/join/spectator/:token`

2. Frontend join resolver requests one-time ticket:
   - `POST /api/gateway/join/spectator/:token/session-ticket`
   - Backend returns `observerTicket`.

3. Frontend redirects spectator to app page:
   - `/spectator?jobAiId=<id>&joinToken=<token>&observerTicket=<ticket>`

4. Spectator page resolves runtime context:
   - Loads interview detail, meetings snapshot, runtime snapshot.
   - Uses meeting arbiter priority:
     - `runtime_snapshot` > `sse_snapshot` > `projection` > `meetings_snapshot`.
   - Calculates `effectiveMeetingId`.

5. Spectator page allows Stream connect only when meeting is active:
   - `effectiveMeetingId` exists
   - meeting status is `starting` or `in_meeting` (projection or runtime)

6. Observer card requests Stream token:
   - `POST /api/stream/token` with `role=spectator`
   - Includes `observerTicket` (and `joinToken` fallback).
   - Server consumes/validates one-time ticket and binds meeting.

7. Observer joins Stream call:
   - `streamCall.join({ create: false, video: false })`
   - `create: false` prevents ghost-call creation.
   - Camera/mic are disabled to keep observer read-only.

8. Observer renders remote participants:
   - Candidate and agent streams are shown.
   - Local observer tile is intentionally excluded from session mirror layout.
   - Optional observer self-preview is local-only and does not publish media.

9. Runtime updates:
   - Spectator listens SSE: `/api/gateway/runtime/:meetingId/stream`
   - On SSE instability: exponential retry then slow-retry mode.
   - Polling remains as fallback source of truth.

## Security and Permission Model

### One-time Observer Ticket

- Issued by backend on spectator join-link flow.
- Short-lived and single-use.
- Consumed during spectator token issuance.
- Prevents replay and arbitrary meeting access.

### Stream Join Safety

- Observer uses `join({ create: false })`.
- Observer does not publish camera/mic (`video: false`, explicit disable calls).

### Backend Runtime Command Guard

- Observer-issued runtime commands are restricted server-side.
- Allowed set currently includes only:
  - `observer.reconnect`
- Other commands are rejected with `403`.

## State Model

Observer connection statuses:

- `waiting_meeting`
- `joining`
- `joined`
- `no_participants`
- `error`
- `idle_hidden`

Mapped UI video states:

- `idle`, `connecting`, `connected`, `no_participants`, `failed`, `hidden`

## Key Frontend Files

- `app/spectator/page.tsx`
  - meeting resolution, active-state gating, SSE + polling orchestration
- `components/interview/observer-stream-card.tsx`
  - token request, ticket refresh, Stream join, read-only media behavior
- `app/api/stream/token/route.ts`
  - spectator token issuance path, observer ticket validation/consume
- `app/join/_components/join-resolver.tsx`
  - join-link resolution and observer ticket bootstrap

## Operational Notes

- If meeting is `completed`, spectator is expected to wait and not connect.
- Seeing only candidate + agent in mirror layout is expected; local observer is hidden from that grid by design.
- Stream dashboard participant visibility can lag briefly until WS presence settles after join.

