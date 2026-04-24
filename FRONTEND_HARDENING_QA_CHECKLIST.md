# Frontend Hardening QA Checklist

## Automated

- [x] `npm run lint`

## Manual smoke scenarios

- [ ] `meetingAt` guard blocks start before scheduled time (expected business message shown).
- [ ] Start session at/after `meetingAt` succeeds and reaches `Connected`.
- [ ] Refresh (`F5`) during active interview restores runtime and keeps stream cards reconnecting.
- [ ] Spectator page (`/spectator?jobAiId=...`) transitions through status states: waiting -> connecting -> connected/no participants.
- [ ] Observer talk toggle enforces agent isolation and resets to `off` when session is not fully connected.
- [ ] Stop session with transient backend slowness eventually succeeds (retry path) and returns UI to `Idle`.
- [ ] Candidate and avatar stream cards recover from transient join failures (auto-retry on next attempt).
- [ ] Кнопка **«Остановить бота»** крупная, красная; после стопа сессия уходит в завершение.
- [ ] У HR-аватара **нет** панели Stream (`CallControls` / видео-режим).
- [ ] Агент: одно приветствие без двойного self-intro; сценарий **intro → вопросы → closing**.
- [ ] Длинный `vacancyText` (>12k символов): в промпте обрезка с пометкой.
- [ ] Ссылка с `?jobAiId=…&entry=candidate`: тот же полный UI (шапка, три колонки, список); до `meetingAt` — подсказка в синем баннере; после — авто-старт при статусах `received`/`pending`; при `in_meeting` с `meetingId`/`sessionId` — гидрация сессии.
- [ ] Вставка URL в поле прототипа у HR: в адресной строке появляются `jobAiId` и при необходимости `entry=candidate`.

## Notes

- Auth/security scope intentionally skipped for this hardening pass by product decision.
