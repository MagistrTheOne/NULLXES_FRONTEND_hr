"use client";

import { Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface MicIndicatorProps {
  active: boolean;
  className?: string;
}

 
export function MicIndicator({ active, className }: MicIndicatorProps) {
  return active ? (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-rose-700 ring-1 ring-inset ring-rose-300",
        className
      )}
      role="status"
      aria-label="Ваш микрофон в эфире, участники вас слышат"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
      </span>
      <Mic aria-hidden className="size-3.5" />
      Ваш микрофон в эфире
    </div>
  ) : (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500 ring-1 ring-inset ring-slate-200",
        className
      )}
      role="status"
      aria-label="Микрофон выключен, вас не слышат"
    >
      <MicOff aria-hidden className="size-3.5" />
      Микрофон выключен
    </div>
  );
}
