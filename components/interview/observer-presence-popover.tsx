"use client";

import { History } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PresenceEvent } from "@/hooks/use-presence-log";

type ObserverPresencePopoverProps = {
  events: PresenceEvent[];
};

function formatOffset(offsetMs: number): string {
  const total = Math.max(0, Math.floor(offsetMs / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function ObserverPresencePopover({ events }: ObserverPresencePopoverProps) {
  return (
    <Popover>
      <PopoverTrigger>
        <button type="button" className="inline-flex h-10 min-h-10 items-center rounded-full border border-slate-300 bg-white px-4 text-sm">
          <History className="mr-2 h-4 w-4" />
          Лог
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] p-0">
        <div className="border-b border-slate-200 px-3 py-2 text-sm font-medium text-slate-800">События присутствия</div>
        <ScrollArea className="h-64 p-3">
          {events.length === 0 ? <p className="text-xs text-slate-500">Пока нет событий</p> : null}
          <div className="space-y-2">
            {events
              .slice()
              .reverse()
              .map((event) => (
                <p key={event.id} className="text-xs text-slate-700">
                  <span className="font-medium text-slate-900">{formatOffset(event.offsetMs)}</span>
                  {" · "}
                  {event.text}
                </p>
              ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

