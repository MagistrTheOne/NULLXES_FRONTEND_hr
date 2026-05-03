"use client";

import { useState } from "react";
import { Flag, Star } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type HrFlagKind = "strong" | "red";

type HrFlag = {
  id: string;
  kind: HrFlagKind;
  ts: number;
};

const FLAG_META: Record<HrFlagKind, { label: string; tone: string; Icon: typeof Star }> = {
  strong: {
    label: "Сильный ответ",
    tone: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    Icon: Star
  },
  red: {
    label: "Красный флаг",
    tone: "bg-rose-50 text-rose-800 ring-rose-200",
    Icon: Flag
  }
};

function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export interface HrInsightPanelProps {
  sessionEnded: boolean;
  streamEnabled: boolean;
  interviewKey?: string | number | null;
}

export function HrInsightPanel({ sessionEnded, streamEnabled, interviewKey }: HrInsightPanelProps) {
  const [flags, setFlags] = useState<HrFlag[]>([]);
  const [trackedInterviewKey, setTrackedInterviewKey] = useState<
    HrInsightPanelProps["interviewKey"]
  >(interviewKey);
  if (trackedInterviewKey !== interviewKey) {
    setTrackedInterviewKey(interviewKey);
    setFlags([]);
  }

  const addQuickFlag = (kind: HrFlagKind): void => {
    if (sessionEnded || !streamEnabled) return;
    setFlags((prev) => [
      ...prev,
      {
        id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind,
        ts: Date.now()
      }
    ]);
  };

  const quickFlagDisabled = sessionEnded || !streamEnabled;

  return (
    <section className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col items-center gap-3">
      <div className="flex w-full flex-col items-center gap-1">
        <h3 className="h-9 shrink-0 text-center text-xl font-medium leading-none text-slate-600 sm:text-[30px]">
          HR наблюдение
        </h3>
        <p className="max-w-[min(100%,20rem)] text-center text-[11px] leading-snug text-slate-500 sm:text-xs">
          Быстрые флаги · {flags.length}
        </p>
      </div>
      <Card className="flex w-full min-h-0 min-w-0 flex-1 flex-col rounded-2xl border-0 bg-[#d9dee7] p-3 shadow-[-8px_-8px_16px_rgba(255,255,255,.9),8px_8px_18px_rgba(163,177,198,.55)]">
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={quickFlagDisabled}
              onClick={() => addQuickFlag("strong")}
              className="h-8 gap-1.5 rounded-lg border-emerald-200 bg-emerald-50/60 px-3 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-40"
            >
              <Star className="h-3.5 w-3.5" /> Сильный
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={quickFlagDisabled}
              onClick={() => addQuickFlag("red")}
              className="h-8 gap-1.5 rounded-lg border-rose-200 bg-rose-50/60 px-3 text-xs text-rose-700 hover:bg-rose-100 disabled:opacity-40"
            >
              <Flag className="h-3.5 w-3.5" /> Флаг
            </Button>
          </div>

          {!streamEnabled ? (
            <p className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-4 text-center text-[11px] text-slate-500">
              Флаги доступны после старта сессии и подключения потока.
            </p>
          ) : flags.length === 0 ? (
            <p className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-4 text-center text-[11px] text-slate-500">
              Отметки появятся здесь после нажатия кнопок выше.
            </p>
          ) : (
            <ul className="max-h-[280px] min-h-[120px] flex-1 space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50/60 p-2">
              {flags.map((f) => {
                const meta = FLAG_META[f.kind];
                const Icon = meta.Icon;
                return (
                  <li
                    key={f.id}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 ring-1",
                      meta.tone
                    )}
                  >
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium">
                      <Icon className="h-3.5 w-3.5" />
                      {meta.label}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] opacity-80">{formatClock(f.ts)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
