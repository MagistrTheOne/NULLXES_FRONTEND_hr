# Контракт для интеграции: `/avatar/*`, `GET /realtime/session`, runtime commands, Stream tile

Документ для **внешней склейки** (например ARACHNE-X ↔ JobAI UI) без догадок. Источник правды — код монорепо: `backend/realtime-gateway` и `frontend/jobaidemo`. Публичные зеркала: [NULLXES_HR_BACKEND](https://github.com/MagistrTheOne/NULLXES_HR_BACKEND), [NULLXES_FRONTEND_hr](https://github.com/MagistrTheOne/NULLXES_FRONTEND_hr).

---

## 1. `POST /avatar/events` и `GET /avatar/state/:meetingId`

Файл: `backend/realtime-gateway/src/routes/avatar.routes.ts`.

### 1.1. `POST /avatar/events`

| Поле | Значение |
|------|----------|
| **Auth** | Заголовок `Authorization: Bearer <AVATAR_SHARED_TOKEN>` (тот же секрет, что у pod при вызове pod; на шлюзе `verifyCallbackToken` сравнивает bearer с `env.AVATAR_SHARED_TOKEN`). Неверный/пустой токен → **401**. |
| **Content-Type** | `application/json` |
| **Тело (JSON)** | Zod-схема `eventSchema`: обязательные `type`, `session_id`, `meeting_id`; опционально `ts` (number ≥ 0), `data` (object). |

Допустимые **`type`** (`POD_EVENT_TYPES`):

| `type` | Эффект на `AvatarStateStore` (`recordEvent`) |
|--------|-----------------------------------------------|
| `avatar_ready` | `phase` → `ready`, **`avatarReady: true`** |
| `transcript_delta` | `phase` → `transcript_delta`, `avatarReady` остаётся как после последнего `ready` |
| `transcript_completed` | `transcript_completed` |
| `response_done` | `response_done`; дополнительно вызывается `meetingOrchestrator.advanceQuestionIndex(meeting_id, …)` если в `data` есть `response_id` / `responseId` |
| `error` | `phase` → `failed`, `lastError` из `data.message` (string) |
| `stopped` | `phase` → `stopped` |

**Correlation keys**

- **`meeting_id`** — ключ строки в `AvatarStateStore` (одна запись на встречу).
- **`session_id`** — OpenAI / gateway **Realtime session id** (строка); при несовпадении с уже сохранённым для этого `meeting_id` шлюз **логирует warning**, но состояние всё равно обновляет.

**Ответ `202`**

```json
{
  "accepted": true,
  "meetingId": "<meeting_id>",
  "sessionId": "<session_id>",
  "phase": "<mapped phase>",
  "avatarReady": <boolean из state после апдейта>
}
```

Если `meeting_id` неизвестен store → `recordEvent` возвращает `null`, в ответе `avatarReady: false`, в логах `avatar event for unknown meeting`.

Параллельно (если включён `RuntimeEventStore`): append события **`avatar.event`** с `payload: { eventType, phase, data, known }`.

**`jobAiId`** в этом маршруте **не передаётся** — связь meeting ↔ jobAi идёт через meeting/interview слой, не через тело pod-callback.

### 1.2. `GET /avatar/state/:meetingId`

| Поле | Значение |
|------|----------|
| **Auth** | В коде **нет** отдельной проверки токена на GET (публичный read внутри perimeter сети; для публичного интернета закрывайте на edge/mTLS). |
| **Ответ 200** | Если состояния нет: `{ meetingId, phase: "unknown", avatarReady: false, enabled: <avatarClient.enabled> }`. Если есть — поля `meetingId`, `sessionId`, `agentUserId?`, `phase`, `avatarReady`, `startedAt`, `lastEventAt`, `lastError?`, `enabled`. |

**Персистентность:** in-memory (`AvatarStateStore`); после рестарта gateway состояние теряется, пока pod снова не пришлёт события (см. комментарий в `avatarStateStore.ts`).

### 1.3. Вызов pod со стороны gateway (контекст ARACHNE в теле)

`AvatarClient.createSession` (`avatarClient.ts`) шлёт на **`POST {AVATAR_POD_URL}/sessions`** с `Authorization: Bearer AVATAR_SHARED_TOKEN` и JSON, где уже есть блок **`arachne`** (prompt, resolution, steps, guidance) плюс `meeting_id`, `session_id`, `openai`, `sfu` (Stream token для `agent_<sessionId>`), опционально `reference_image`, `emotion`. Это **не** тот же JSON, что в `POST /avatar/events` callback.

---

## 2. Что означает `avatar_ready` в `GET /realtime/session/:sessionId`

Файлы: `backend/realtime-gateway/src/routes/realtime.routes.ts` (`GET …` → `{ session }`), `backend/realtime-gateway/src/services/sessionStore.ts`, `frontend/jobaidemo/hooks/use-interview-session.ts`.

### 2.1. Структура ответа

`SessionRecord` (`backend/realtime-gateway/src/types/realtime.ts`):

- `id`, `status`, `createdAt`, `updatedAt`, `lastActivityAt`, `closedAt?`, `remoteCallId?`, `lastError?`
- **`eventCount`**, **`eventTypeCounts: Record<string, number>`**

`eventTypeCounts[type]` увеличивается **только** при **`POST /realtime/session/:sessionId/events`**: каждое событие с разрешённым `type` (см. `validateDataChannelEvent`) → `registerEvent`.

### 2.2. Кто выставляет счётчик для строк вроде `avatar_ready`

- **Прямо pod через `/avatar/events` — нет**, это другой store (`AvatarStateStore`).
- В **`eventTypeCounts`** попадёт `avatar_ready` (или `avatar.ready`, …) только если **кто-то** отправил на **`POST /realtime/session/:id/events`** JSON с таким полем `type` / `eventType` (например зеркалирование из pod, фронт, или OpenAI-событие, продублированное клиентом).

Фронт сейчас шлёт напр. `candidate.stream.joined` / `candidate.stream.left` (`candidate-stream-card.tsx`), плюс телеметрию из `webrtc-client.ts` и `emitFrontendTelemetry` — **не** обязательно строку `avatar_ready`.

### 2.3. Что делает фронт сейчас

`AVATAR_READY_EVENT_TYPES` в `use-interview-session.ts`:

`avatar_ready`, `avatar.ready`, `agent.avatar.ready`, `avatar.stream.joined`

Опрос **`GET /realtime/session/:sessionId`** считает «готово», если **любой** из этих ключей в `eventTypeCounts` > 0.

**Edge cases**

| Ситуация | Поведение |
|----------|-----------|
| Pod прислал только `POST /avatar/events` с `avatar_ready`, но **ничего** не шлёт на `/realtime/session/.../events` | `eventTypeCounts["avatar_ready"]` может остаться **0**; фронтовый `avatarReady` по **Realtime session** останется false, хотя **`GET /runtime/:meetingId`** вернёт `avatar.avatarReady: true`** (см. §3). |
| **404** на `GET /realtime/session/:id` | Нет записи в `sessionStore` (новый gateway, другой инстанс, сессия не создавалась, sweeper). Фронт трактует как «телеметрия недоступна», не обязательно «аватар мёртв». |
| Рестарт gateway | In-memory session и avatar state сбрасываются. |
| Несовпадение `session_id` в pod callback и реального OpenAI session id | Warning в логах; `avatarReady` в store может обновиться неконсистентно с WebRTC. |

**Авторитетный признак готовности аватара для оркестрации:** поле **`avatar`** в **`GET /runtime/:meetingId`** (`RuntimeSnapshot`), см. `runtimeSnapshotService.ts` (`avatarStateStore.get`, предупреждение `avatar_not_ready`).

---

## 3. `GET /runtime/:meetingId` и связь с аватаром

- В snapshot есть **`avatar: AvatarState | null`** — то же состояние, что обновляет **`POST /avatar/events`**.
- При активной встрече без готовности аватара в **`warnings`** может быть **`avatar_not_ready`**.

Фронтовый **Next.js proxy** разрешает `runtime` и `realtime` (`app/api/gateway/[...path]/route.ts`). Прямой **`/avatar/*`** через этот proxy **не** в allowlist — браузер **не** дергает `GET /avatar/state/...` через `/api/gateway` без расширения списка.

---

## 4. `POST /runtime/:meetingId/commands`

Файлы: `backend/realtime-gateway/src/routes/runtime.routes.ts`, `backend/realtime-gateway/src/types/runtime.ts`.

### 4.1. Тело запроса (Zod `commandSchema`)

Обязательное поле **`type`** — одно из:

| `type` | Назначение |
|--------|------------|
| `agent.pause` | Пауза агента (UI HR). |
| `agent.resume` | Возобновление. |
| `agent.cancel_response` | Отмена текущей реплики. |
| `agent.force_next_question` | Форс следующего вопроса; на шлюзе вызывается `advanceQuestionIndex`. |
| `agent.end_interview` | Завершение интервью со стороны управления. |
| `observer.reconnect` | **Единственная** команда, разрешённая для `issuedBy` наблюдателя (`observer_ui` / префикс `observer:`). |
| `session.stop` | Остановка сессии. |

Опционально: **`issuedBy`** (string ≤120), **`commandId`** (string ≤160), **`payload`** (object).

### 4.2. Поведение

- Lease на ключ `runtime-command:${meetingId}` (5s); конфликт → **409**.
- Наблюдатель с read-only: любая команда кроме `observer.reconnect` → **403** + событие `observer_command_denied`.
- Успех → **202** `{ command: RuntimeCommandRecord }` и события в runtime stream (`runtime.command.requested`, и т.д.).

### 4.3. Куда логично повесить `ARACHNE_START` / `STOP` / `RELOAD_STYLE`

Сейчас **таких типов нет** — нужно:

1. Расширить enum в **`commandSchema`** и **`RuntimeCommandType`** в `types/runtime.ts`.
2. В обработчике после `append`/`recordCommand` вызвать сервис (новый или `MeetingOrchestrator` / `AvatarClient`), который дергает ARACHNE или pod.
3. Задокументировать **payload** (например `{ styleId: string }`) и **issuedBy** (например `arachne_controller`).

Альтернатива без новых команд: **`POST /runtime/:meetingId/events`** с `eventIngestSchema` — разрешённые `type`: `stream.token.issued`, `realtime.session.event`, **`avatar.event`**, события admission. Можно добавить новый тип в enum и обработчик ingest (аналогично расширению схемы).

---

## 5. Stream: «avatar tile» в UI

### 5.1. HR панель аватара

`frontend/jobaidemo/components/interview/avatar-stream-card.tsx`:

- Токен: **`POST /api/stream/token`** с телом `role: "spectator"`, `viewerKind: "hr_avatar_panel"`, `meetingId`, `userId: "avatar-viewer-${meetingId}"`, `userName`.
- **`StreamVideoClient`** → `call(callType, callId)` → **`join({ create: false, video: false })`** — слушатель комнаты, **без** публикации своей камеры.
- Видео агента в UI: через **`StreamVideo` / `ParticipantView`** (внутри компонента — рендер участника с видео-треком). Пока нет трека — плейсхолдер **`/anna.jpg`** (`AvatarPlaceholder`).
- Проп **`avatarReady`** (из родителя, обычно из `useInterviewSession`) влияет на то, **когда** считается окно «В эфире» / разрешён ли рендер видео (`canRenderAvatarWindow`), совместно с `call` и `enabled`.

### 5.2. Наблюдатель

`observer-stream-card.tsx`: сетка кандидат + HR; для агента при наличии участника — **`<ParticipantView participant={agentParticipant} trackType="videoTrack" />`**, иначе картинка или «Ожидание HR аватара».

### 5.3. Куда «подавать» видео с ARACHNE

Продуктовый путь сейчас: **агент = участник Stream** с user id вида **`agent_<sessionId>`** (см. `AvatarClient.createSession`), публикация видео **в ту же комнату** (`call_id` = `meetingId`, тип из `STREAM_CALL_TYPE`). ARACHNE как генератор кадров должен оказаться **внутри цепочки pod**, который уже получает `arachne` block при create session, либо заменить/дополнить источник publisher-трека на стороне pod/SDK — **не** через отдельный URL в Next без доработки.

---

## 6. Happy path (HAR-чеклист, без секретов)

Подставьте свои id; в HAR **маскируйте** `Authorization`, `token`, SDP body при необходимости.

| # | Метод | URL (как в браузере) | Примечание |
|---|--------|----------------------|------------|
| 1 | `POST` | `/api/gateway/meetings/start` | Тело: metadata/triggerSource по контракту; ответ — `meetingId`, далее UI знает meeting. |
| 2 | `GET` | `/api/gateway/realtime/token` | Ephemeral OpenAI; в ответе есть `sessionId`, но **`WebRtcInterviewClient` для медиа использует только `sessionId` из шага 3** (`x-session-id` у `POST /realtime/session`). Идентификатор из шага 2 не подставляется в `connect()` как текущая сессия. |
| 3 | `POST` | `/api/gateway/realtime/session` | `Content-Type: application/sdp`, body = SDP offer; ответ SDP answer, заголовок **`x-session-id`**. |
| 4 | WebSocket / QUIC | (не в HAR как HTTP) | WebRTC media + DataChannel `oai-events`. |
| 5 | `POST` | `/api/gateway/realtime/session/<sessionId>/events` | Поток телеметрии (часть событий с клиента). |
| 6 | `GET` | `/api/gateway/realtime/session/<sessionId>` | Повторять каждые ~2s: смотреть `session.eventTypeCounts`, `session.status`. |
| 7 | `POST` | `/api/stream/token` | Для кандидата/наблюдателя/HR avatar — разные body. |
| 8 | `GET` | `/api/gateway/runtime/<meetingId>` | Снимок: `avatar`, `meeting`, `admission`, и т.д. |

**Замечание по шагам 2–3:** в `realtime.routes.ts` **`GET /token`** создаёт session в store с одним uuid, а **`POST /session`** создаёт **новую** сессию с другим uuid для SDP — убедитесь в трассировке, какой **`sessionId`** реально использует фронт (`WebRtcInterviewClient` / `createRealtimeSession` ответ `x-session-id`). Это критично для сопоставления с pod callback `session_id`.

---

## 7. Permalink на исходники (монорепо)

| Тема | Путь |
|------|------|
| Avatar routes | `backend/realtime-gateway/src/routes/avatar.routes.ts` |
| Avatar → pod HTTP | `backend/realtime-gateway/src/services/avatarClient.ts` |
| Avatar state | `backend/realtime-gateway/src/services/avatarStateStore.ts` |
| Realtime GET/POST | `backend/realtime-gateway/src/routes/realtime.routes.ts` |
| Session store | `backend/realtime-gateway/src/services/sessionStore.ts` |
| Runtime commands | `backend/realtime-gateway/src/routes/runtime.routes.ts` |
| Runtime types | `backend/realtime-gateway/src/types/runtime.ts` |
| Snapshot + avatar | `backend/realtime-gateway/src/services/runtimeSnapshotService.ts` |
| Gateway allowlist (Next) | `frontend/jobaidemo/app/api/gateway/[...path]/route.ts` |
| Опрос avatar / session | `frontend/jobaidemo/hooks/use-interview-session.ts` |
| HR Stream tile | `frontend/jobaidemo/components/interview/avatar-stream-card.tsx` |
| Candidate Stream | `frontend/jobaidemo/components/interview/candidate-stream-card.tsx` |

---

*При смене контрактов обновляйте этот файл вместе с PR.*
