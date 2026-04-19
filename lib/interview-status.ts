import type { InterviewPhase, RuntimeRecoveryState } from "@/hooks/use-interview-session";

/**
 * Презентационный статус интервью для пользователя. Производный от внутренних
 * runtime-состояний (`InterviewPhase`, `RuntimeRecoveryState`, completedLocked,
 * countdown warning), но описывает не «что внутри», а «что с интервью».
 *
 * Используется одним и тем же mapping'ом и для HR (operator-tone), и для
 * candidate (narrative-tone) — режим выбирается через параметр `mode`.
 */

export type InterviewStatusTone = "slate" | "amber" | "emerald" | "rose" | "sky";

export type InterviewStatusIcon =
  | "play"
  | "hourglass"
  | "loader"
  | "radio"
  | "alertTriangle"
  | "refresh"
  | "checkCircle";

export interface InterviewStatusView {
  /** Короткая фраза для бейджа (1-3 слова). */
  label: string;
  /** Цветовая семантика — окрашивает дотик и фон бейджа. */
  tone: InterviewStatusTone;
  /** Иконка для leading-slot бейджа. */
  icon: InterviewStatusIcon;
  /** Полное описание для screen reader / aria-label. */
  ariaLabel: string;
}

interface MapPhaseToStatusInput {
  phase: InterviewPhase;
  runtimeRecoveryState: RuntimeRecoveryState;
  completedLocked: boolean;
  /** Контекст готов к запуску (имя, вакансия, вопросы и т.п.). */
  contextReady?: boolean;
  /** Активен warning-режим session countdown (<60 сек до auto-end). */
  countdownWarning?: boolean;
  /** Кому показываем — HR-оператору или кандидату. */
  mode?: "hr" | "candidate";
}

/** Статус по умолчанию для пустого / неинициализированного состояния. */
const FALLBACK: InterviewStatusView = {
  label: "Готово к запуску",
  tone: "slate",
  icon: "play",
  ariaLabel: "Интервью готово к запуску"
};

export function mapPhaseToStatus(input: MapPhaseToStatusInput): InterviewStatusView {
  const {
    phase,
    runtimeRecoveryState,
    completedLocked,
    contextReady = true,
    countdownWarning = false,
    mode = "hr"
  } = input;

  if (runtimeRecoveryState === "recovering") {
    return {
      label: "Восстановление…",
      tone: "sky",
      icon: "refresh",
      ariaLabel: "Восстанавливаем подключение к интервью"
    };
  }

  if (completedLocked || phase === "idle") {
    if (completedLocked) {
      return {
        label: "Завершено",
        tone: "slate",
        icon: "checkCircle",
        ariaLabel: "Интервью завершено"
      };
    }
    if (!contextReady) {
      return {
        label: mode === "candidate" ? "Подготовка…" : "Ожидание данных",
        tone: "slate",
        icon: "hourglass",
        ariaLabel:
          mode === "candidate"
            ? "Готовим интервью к запуску"
            : "Ожидаем загрузки данных интервью"
      };
    }
    return mode === "candidate"
      ? {
          label: "Скоро начнём",
          tone: "slate",
          icon: "play",
          ariaLabel: "Интервью скоро начнётся"
        }
      : FALLBACK;
  }

  if (phase === "starting") {
    return {
      label: "Подключение…",
      tone: "amber",
      icon: "loader",
      ariaLabel: "Подключаем агента и видеопоток"
    };
  }

  if (phase === "stopping") {
    return {
      label: "Финализация…",
      tone: "amber",
      icon: "loader",
      ariaLabel: "Сохраняем итоги и завершаем интервью"
    };
  }

  if (phase === "failed") {
    return {
      label: "Ошибка интервью",
      tone: "rose",
      icon: "alertTriangle",
      ariaLabel: "Произошла ошибка во время интервью"
    };
  }

  if (phase === "connected") {
    if (countdownWarning) {
      return {
        label: mode === "candidate" ? "Идёт интервью · скоро финал" : "Идёт интервью · скоро финал",
        tone: "amber",
        icon: "radio",
        ariaLabel: "Интервью идёт, до автозавершения меньше минуты"
      };
    }
    return mode === "candidate"
      ? {
          label: "Идёт разговор",
          tone: "emerald",
          icon: "radio",
          ariaLabel: "Идёт разговор с интервьюером"
        }
      : {
          label: "Идёт интервью",
          tone: "emerald",
          icon: "radio",
          ariaLabel: "Интервью идёт"
        };
  }

  return FALLBACK;
}

// ---------- Local video-channel status (observer / spectator only) ----------

/**
 * Состояния локального видеопотока в карточке наблюдателя — независимо от
 * статуса самого интервью. Спектатор может видеть «Идёт интервью» (общий
 * статус), но при этом «Подключаемся к видео…» (локальный) если SFU ещё
 * не подтвердил публикацию треков.
 */
export type VideoConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "no_participants"
  | "failed"
  | "hidden";

export function mapVideoStatus(state: VideoConnectionState): InterviewStatusView {
  switch (state) {
    case "connecting":
      return {
        label: "Подключаемся к видео…",
        tone: "amber",
        icon: "loader",
        ariaLabel: "Подключаемся к видеопотоку"
      };
    case "connected":
      return {
        label: "Видео подключено",
        tone: "emerald",
        icon: "radio",
        ariaLabel: "Видеопоток подключён"
      };
    case "no_participants":
      return {
        label: "Ожидание участников",
        tone: "slate",
        icon: "hourglass",
        ariaLabel: "Видео подключено, ожидаем участников"
      };
    case "failed":
      return {
        label: "Ошибка видео",
        tone: "rose",
        icon: "alertTriangle",
        ariaLabel: "Не удалось подключить видеопоток"
      };
    case "hidden":
      return {
        label: "Видео скрыто",
        tone: "slate",
        icon: "play",
        ariaLabel: "Видеопоток скрыт"
      };
    case "idle":
    default:
      return {
        label: "Ожидание запуска",
        tone: "slate",
        icon: "hourglass",
        ariaLabel: "Ожидаем запуск интервью"
      };
  }
}

/**
 * Helper для spectator/page.tsx: маппинг runtime-статуса интервью с gateway
 * (`InterviewProjection.nullxesStatus`) в `InterviewPhase` для подачи в
 * mapPhaseToStatus. Spectator не видит сырых InterviewPhase — только то что
 * gateway знает о meeting'е.
 */
export type ProjectionLikeStatus = "idle" | "in_meeting" | "completed" | "stopped_during_meeting" | "failed";

export function mapProjectionToInterviewStatus(
  projectionStatus: ProjectionLikeStatus | string | undefined,
  options?: { contextReady?: boolean }
): InterviewStatusView {
  const completedLocked = projectionStatus === "completed" || projectionStatus === "stopped_during_meeting";
  const phase: InterviewPhase =
    projectionStatus === "in_meeting"
      ? "connected"
      : projectionStatus === "failed"
        ? "failed"
        : "idle";
  return mapPhaseToStatus({
    phase,
    runtimeRecoveryState: "idle",
    completedLocked,
    contextReady: options?.contextReady ?? true,
    countdownWarning: false,
    mode: "hr"
  });
}
