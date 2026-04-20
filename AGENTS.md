<!-- BEGIN:nullxes-frontend-agent-notes -->
# NULLXES / HR AI — Frontend agent notes

**Репозиторий:** [NULLXES_FRONTEND_hr](https://github.com/MagistrTheOne/NULLXES_FRONTEND_hr.git) (root = этот `frontend/jobaidemo/`, subtree-push из monorepo).
**Деплой:** Vercel, root directory = `.`.
**Последний push:** `b628941` (20.04.2026).

> Это НЕ тот Next.js, что в тренировке. Перед правками проверяй `node_modules/next/dist/docs/` и реальное API. Не плоди вторую Next-app в корне monorepo.

---

## Что это

Next.js 15 App Router. Два flow на одной кодовой базе:
- **candidate-flow** — кандидат входит по персональной ссылке (`/?entry=candidate&jobAiId=...` или `/join/candidate/<JWT>`). Только он может стартовать AI-сессию.
- **HR-dashboard** — `/` без entry-params, видит список интервью, live-observer, summary, «Остановить бота», «Завершить». НЕ инициирует сессию.

Голос/видео: **Stream Video SDK** + **OpenAI Realtime API** (через свой WebRTC peer + наш `backend/realtime-gateway`).

---

## Карта ключевых файлов

### Сессия / runtime
| Файл | За что отвечает |
|---|---|
| `hooks/use-interview-session.ts` | Главный хук. `start()` / `stop()` / hydrate / reconnect. Whitelist `triggerSource` (candidate-only). postEvent в Realtime. |
| `lib/webrtc-client.ts` | WebRTC peer к OpenAI Realtime (data channel + audio tracks). |
| `lib/api.ts` | `requestJson` c timeout/retry. Default critical timeout = 12000мс. |
| `app/api/stream/token/route.ts` | Минтит Stream-токен (HR/candidate/observer). |
| `app/api/gateway/[...path]/route.ts` | Прокси во `backend/realtime-gateway`, `AbortSignal.timeout(60_000)`. |

### Промпт агента
| Файл | За что отвечает |
|---|---|
| `lib/interview-agent-prompt.ts` | `buildInterviewInstructions(ctx)` + `buildAdaptiveInterviewerContract(...)` + `buildOpeningUtterance(ctx, mode)`. **ВСЯ** персона / ВОК / правила / anti-robot. |
| `lib/interview-opening-utterance.ts` | Первая реплика агента после connect. |
| `lib/interview-start-context.ts` | Тип `InterviewStartContext`. |
| `lib/interview-detail-merge.ts` | Мердж контекста с ответом `GET /interviews/:id`. |
| `lib/interview-context-diagnostics.ts` | `evaluateRequiredContext(...)` — HARD_CONTEXT_GUARD. |
| `lib/agent-context-trace.ts` | Snapshot «что агент увидел» для HR-debug панели. |

### UI / интервью
| Файл | За что отвечает |
|---|---|
| `components/interview/interview-shell.tsx` | Главный контейнер. Исполняет flow-детекцию, grid, exit/complete → redirect. |
| `components/interview/candidate-stream-card.tsx` | Видео кандидата + join Stream. Фильтр transient-ошибок (`isTransientTransportError`). |
| `components/interview/avatar-stream-card.tsx` | HR-avatar viewer. Whitelist `agent_*` / `agent-<meetingId>`. Placeholder = `public/anna.jpg`. |
| `components/interview/observer-stream-card.tsx` | Spectator. `/spectator?jobAiId=N`. |
| `components/interview/meeting-header.tsx` | HR-dashboard CTA. Кнопка «Запустить» УДАЛЕНА, badge «Ожидаем кандидата». |
| `components/interview/interview-summary-display.tsx` | Свёрнутая карточка саммари. Gradient-бары, shadcn/ui. |
| `components/interview/thank-you-screen.tsx` | Финал кандидата, `router.push("/")`. |

### Summary
| Файл | За что отвечает |
|---|---|
| `lib/interview-summary.ts` | `decisionFromScore` (≥7.5 recommended, 5.0–7.4 consider, <5.0 rejected). Baseline 6/6/6/6 → default «consider». |
| `app/api/interview/summary/route.ts` | OpenAI суммари. `SYSTEM_BASE` + `SYSTEM_NO_TRANSCRIPT`. |

---

## Последнее состояние (20.04.2026)

Сегодня (см. релиз-ноты в чате): 5 коммитов, `778d57b..b628941`.

- `baafe49` — роль-гард: только candidate-flow стартует AI. HR-кнопка «Запустить» удалена.
- `87ff98e` — фильтр transient-ошибок у кандидата. Кандидат не видит «Остановить бота».
- `f4fbf7f` — Stream SDK `options.timeout = 60_000` (дефолт axios был 5000мс → ломал сессии).
- `5b6b6c6` — 9 вставок в `interview-agent-prompt.ts`: ROTATION, BLACK-LIST, hard-cap на ФИО, pause-осмысления, запрет filler-ов.

Перед этим (`778d57b`): exit-to-home redirect + `anna.jpg` placeholder + summary v2.

---

## Gotchas (грабли, на которые я уже наступал)

1. **`session.update` + `turn_detection`** — OpenAI Realtime GA endpoint **молча реджектит** весь update, если в нём `turn_detection`. Instructions уходят в void, агент идёт в дефолтное приветствие. **Только минимальный payload** в `postEvent`:
   ```ts
   { type: "session.update", session: { type: "realtime", instructions } }
   ```
   VAD-тюнинг делать через multipart `session` при POST `/v1/realtime/calls` на backend (pending).

2. **`session.update` → `response.create`** — нужна пауза 800мс между ними. Иначе `response.create` прилетает раньше `session.updated` и агент ждёт первого аудио кандидата вместо intro. См. `postIntroResponseToRtc` в `use-interview-session.ts`.

3. **HR-avatar tile fallback** — НИКОГДА не делай `participants.find(p => p.userId !== "viewer-...")`. Это подтянет кандидата. Только whitelist `agent_*` / `agent-<meetingId>`.

4. **Stream SDK axios default = 5с.** Внутри `@stream-io/video-client/dist/index.es.js:16211`. Передавай `options: { timeout: 60_000 }` в `new StreamVideoClient({...})`.

5. **HR не инициирует сессию.** `use-interview-session.start()` whitelist'ит `triggerSource`. Если добавляешь новый trigger — он должен начинаться с `candidate_` или входить в `CANDIDATE_INITIATED_TRIGGERS`.

6. **Tailwind v4** — `bg-linear-to-r`, не `bg-gradient-to-r`. ESLint ругается.

7. **Git**: не пушь monorepo root. Только subtree:
   ```bash
   git subtree push --prefix=frontend/jobaidemo frontend main
   ```

8. **HARD_CONTEXT_GUARD_ENABLED** — гард в `start()` валит сессию если нет candidate/company/jobTitle/vacancyText/questions. Смотри `evaluateRequiredContext`. Для debug-старта без полного контекста — выключать через env.

---

## Pending (куда дальше)

- **Observer bug** — `/spectator?jobAiId=N` зависает на «Подключаемся к видео…». Нужно проверить SFU join + token scope в `observer-stream-card.tsx`.
- **VAD-тюнинг на backend** — убрать эхо/шумоподавление через multipart `session` в `openaiRealtimeClient.createCall()` вместо runtime `session.update`.
- **Timeout retry-политика** — добавить exponential back-off для `/api/stream/token` refresh (уже подняли до 60с на SDK, но логика retry отдельная).

---

## Команды (Windows/PowerShell)

```powershell
# dev
cd frontend/jobaidemo
npm run dev

# type-check (БЕЗ head/tail — PowerShell их не знает)
npx tsc --noEmit -p tsconfig.json 2>&1 | Select-Object -Last 40

# subtree push (из корня monorepo)
git subtree push --prefix=frontend/jobaidemo frontend main

# commit через temp-файл (heredoc в PowerShell не работает)
# Write to .git/COMMIT_MSG.txt, then:
git commit -F .git/COMMIT_MSG.txt
```
<!-- END:nullxes-frontend-agent-notes -->
