import type { ReactNode, RefObject } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

//Сетка трёх колонок: на mobile-portrait тайл подстраивается под ширину.
export const STREAM_VIDEO_BOX_CLASS =
  "stream-card-viewport relative aspect-video w-full min-h-[180px] shrink-0 overflow-hidden rounded-xl border border-white/50 bg-[#d0d6e0] sm:aspect-auto sm:h-[420px] sm:min-h-[420px]";

export const STREAM_CARD_FOOTER_CLASS = "flex min-h-[56px] w-full shrink-0 flex-col justify-end gap-2 sm:min-h-[64px]";

type StreamParticipantShellProps = {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  error?: ReactNode;
  videoRef?: RefObject<HTMLDivElement | null>;
  videoClassName?: string;
//для фронтенда от магистра это режим PIP -полезешь руками сломаешь мозги.
  compact?: boolean;
};

export function StreamParticipantShell({
  title,
  description,
  children,
  footer,
  error,
  videoRef,
  videoClassName,
  compact = false
}: StreamParticipantShellProps) {
  return (
    <section className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col items-center gap-3">
      <div
        className={cn(
          "w-full flex-col items-center gap-1",
          compact ? "hidden lg:flex" : "flex"
        )}
      >
        <h3 className="h-9 shrink-0 text-center text-xl font-medium leading-none text-slate-600 sm:text-[30px]">{title}</h3>
        {description ? (
          <p className="max-w-[min(100%,20rem)] text-center text-[11px] leading-snug text-slate-500 sm:text-xs">{description}</p>
        ) : null}
      </div>
      <Card
        className={cn(
          "flex w-full min-h-0 min-w-0 flex-1 flex-col rounded-2xl border-0 bg-[#d9dee7] shadow-[-8px_-8px_16px_rgba(255,255,255,.9),8px_8px_18px_rgba(163,177,198,.55)]",
          compact ? "p-1 lg:p-3" : "p-3"
        )}
      >
        <CardContent className={cn("flex min-h-0 flex-1 flex-col gap-2", compact ? "p-1 lg:p-2" : "p-2")}>
          <div ref={videoRef} className={cn(STREAM_VIDEO_BOX_CLASS, videoClassName)}>
            {children}
          </div>
          <div className={cn(STREAM_CARD_FOOTER_CLASS, compact ? "hidden lg:flex" : undefined)}>{footer}</div>
        </CardContent>
      </Card>
      {error}
    </section>
  );
}
