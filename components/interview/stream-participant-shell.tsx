import type { ReactNode, RefObject } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Единая сетка трёх колонок: одинаковая высота «квадрата» видео и подвала под контролы. */
export const STREAM_VIDEO_BOX_CLASS =
  "stream-card-viewport relative h-[320px] min-h-[320px] w-full shrink-0 overflow-hidden rounded-xl border border-white/50 bg-[#d0d6e0] sm:h-[420px] sm:min-h-[420px]";

export const STREAM_CARD_FOOTER_CLASS = "flex min-h-[56px] w-full shrink-0 flex-col justify-end gap-2 sm:min-h-[64px]";

type StreamParticipantShellProps = {
  title: string;
  /** Подзаголовок под названием колонки (подсказка, UX). */
  description?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  error?: ReactNode;
  videoRef?: RefObject<HTMLDivElement | null>;
  videoClassName?: string;
};

export function StreamParticipantShell({
  title,
  description,
  children,
  footer,
  error,
  videoRef,
  videoClassName
}: StreamParticipantShellProps) {
  return (
    <section className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col items-center gap-3">
      <div className="flex w-full flex-col items-center gap-1">
        <h3 className="h-9 shrink-0 text-center text-xl font-medium leading-none text-slate-600 sm:text-[30px]">{title}</h3>
        {description ? (
          <p className="max-w-[min(100%,20rem)] text-center text-[11px] leading-snug text-slate-500 sm:text-xs">{description}</p>
        ) : null}
      </div>
      <Card className="flex w-full min-h-0 min-w-0 flex-1 flex-col rounded-2xl border-0 bg-[#d9dee7] p-3 shadow-[-8px_-8px_16px_rgba(255,255,255,.9),8px_8px_18px_rgba(163,177,198,.55)]">
        <CardContent className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <div ref={videoRef} className={cn(STREAM_VIDEO_BOX_CLASS, videoClassName)}>
            {children}
          </div>
          <div className={STREAM_CARD_FOOTER_CLASS}>{footer}</div>
        </CardContent>
      </Card>
      {error}
    </section>
  );
}
