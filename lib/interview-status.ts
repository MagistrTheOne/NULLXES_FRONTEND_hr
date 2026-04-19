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
