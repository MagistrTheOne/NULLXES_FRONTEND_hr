"use client";

/**
 * HR Insight Panel (P4 — right column on the HR dashboard).
 *
 * Replaces the legacy Observer tile and gives the interviewer a live operational
 * view during the session:
 *   - live per-turn transcript (agent + candidate) with role-colored bubbles;
 *   - quick-flag buttons (strong answer / red flag / HR comment) that stamp the
 *     most recent candidate turn — flags are kept in local component state and
 *     are meant as an immediate shorthand for HR while the session runs;
 *   - interview summary display (reuses InterviewSummaryDisplay) once the
 *     post-session summary event arrives.
 *
 * This panel is READ-mostly from the hook: all actual transcript data comes from
 * useInterviewSession().transcripts (agent + candidate audio transcription).
 * The flag state is UI-local — persistence / gateway sync is a P5 item.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Flag, MessageSquarePlus, Star, StickyNote } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TranscriptTurn } from "@/hooks/use-interview-session";
import type { InterviewSummaryPayload } from "@/lib/interview-summary";
import { InterviewSummaryDisplay } from "./interview-summary-display";

type HrFlagKind = "strong" | "red" | "note";

type HrFlag = {
  id: string;
  kind: HrFlagKind;
  // Index into the transcripts array that this flag is attached to.
  // -1 means "not yet tied to a specific candidate turn" (free-floating note).
  turnIndex: number;
  /** Optional free-text attached by HR (only for kind === "note"). */
  text?: string;
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
  },
  note: {
    label: "Заметка HR",
    tone: "bg-sky-50 text-sky-900 ring-sky-200",
    Icon: StickyNote
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
  transcripts: TranscriptTurn[];
  summary: InterviewSummaryPayload | null;
  /** "Interview is over" — panel should lock flag controls. */
  sessionEnded: boolean;
  /** "Not connected yet" — panel shows a placeholder. */
  streamEnabled: boolean;
  /** Optional key used to clear flag state between different interviews. */
  interviewKey?: string | number | null;
}

export function HrInsightPanel({
  transcripts,
  summary,
  sessionEnded,
  streamEnabled,
  interviewKey
}: HrInsightPanelProps) {
  const [flags, setFlags] = useState<HrFlag[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // React "adjusting state when a prop changes" pattern: reset local flag
  // state synchronously during render when the interview switches. This
  // avoids a useEffect + setState cascade and keeps the UI consistent on
  // the very first render after a row change.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [trackedInterviewKey, setTrackedInterviewKey] = useState<
    HrInsightPanelProps["interviewKey"]
  >(interviewKey);
  if (trackedInterviewKey !== interviewKey) {
    setTrackedInterviewKey(interviewKey);
    setFlags([]);
    setNoteDraft("");
  }

  // Auto-scroll transcript to bottom when new turn arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcripts.length]);

  const lastCandidateTurnIndex = useMemo(() => {
    for (let i = transcripts.length - 1; i >= 0; i -= 1) {
      const t = transcripts[i];
      if (t && t.role === "candidate") return i;
    }
    return -1;
  }, [transcripts]);

  const flagsByTurnIndex = useMemo(() => {
    const map = new Map<number, HrFlag[]>();
    for (const f of flags) {
      const bucket = map.get(f.turnIndex) ?? [];
      bucket.push(f);
      map.set(f.turnIndex, bucket);
    }
    return map;
  }, [flags]);

  const freeNotes = useMemo(() => flags.filter((f) => f.turnIndex === -1), [flags]);

  const addQuickFlag = (kind: Exclude<HrFlagKind, "note">): void => {
    if (sessionEnded) return;
    const turnIndex = lastCandidateTurnIndex;
    setFlags((prev) => [
      ...prev,
      {
        id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind,
        turnIndex,
        ts: Date.now()
      }
    ]);
  };

  const addNote = (): void => {
    const text = noteDraft.trim();
    if (!text || sessionEnded) return;
    setFlags((prev) => [
      ...prev,
      {
        id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind: "note",
        // Note is free-floating — not attached to a specific turn. This matches
        // how HR often jots "important" while the candidate is still talking.
        turnIndex: -1,
        text,
        ts: Date.now()
      }
    ]);
    setNoteDraft("");
  };

  const quickFlagDisabled = sessionEnded || lastCandidateTurnIndex === -1;

  return (
    <Card className="flex min-h-0 min-w-0 flex-col rounded-2xl border-slate-200 bg-white/90 shadow-sm lg:h-full">
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b border-slate-100 py-3">
        <CardTitle className="text-sm font-semibold text-slate-800">
          HR наблюдение
        </CardTitle>
        <span className="text-[10px] uppercase tracking-wider text-slate-400">
          live · {transcripts.length} реплик
        </span>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {/* Quick-flag toolbar */}
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

        {/* Live transcript */}
        <div
          ref={scrollRef}
          className="min-h-[160px] flex-1 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50/60 p-2 text-xs leading-relaxed"
        >
          {!streamEnabled && transcripts.length === 0 ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-slate-400">
              Панель включится после старта сессии — здесь будет live-транскрипт диалога, быстрые флаги и финальный summary.
            </div>
          ) : transcripts.length === 0 ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-slate-400">
              Ожидаем первые реплики…
            </div>
          ) : (
            <ul className="space-y-2">
              {transcripts.map((turn, idx) => {
                const attachedFlags = flagsByTurnIndex.get(idx) ?? [];
                const isCandidate = turn.role === "candidate";
                return (
                  <li
                    key={`${turn.itemId ?? turn.ts}-${idx}`}
                    className={cn(
                      "rounded-lg px-2.5 py-1.5 ring-1",
                      isCandidate
                        ? "bg-white ring-slate-200"
                        : "bg-indigo-50/70 ring-indigo-100"
                    )}
                  >
                    <div className="mb-0.5 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider">
                      <span
                        className={cn(
                          "font-semibold",
                          isCandidate ? "text-slate-500" : "text-indigo-700"
                        )}
                      >
                        {isCandidate ? "Кандидат" : "HR · AI"}
                      </span>
                      <span className="text-slate-400">{formatClock(turn.ts)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-[12px] text-slate-800">
                      {turn.text}
                    </p>
                    {attachedFlags.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {attachedFlags.map((f) => {
                          const meta = FLAG_META[f.kind];
                          const Icon = meta.Icon;
                          return (
                            <span
                              key={f.id}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
                                meta.tone
                              )}
                            >
                              <Icon className="h-3 w-3" />
                              {meta.label}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* HR free-form notes */}
        <div className="flex flex-col gap-1.5 rounded-xl border border-slate-100 bg-white/80 p-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600">
            <StickyNote className="h-3.5 w-3.5 text-sky-600" />
            Заметка HR
          </div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addNote();
                }
              }}
              placeholder="Быстрая заметка и Enter…"
              disabled={sessionEnded}
              className="h-8 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-sky-300 focus:outline-none disabled:opacity-40"
            />
            <Button
              type="button"
              size="sm"
              onClick={addNote}
              disabled={sessionEnded || noteDraft.trim().length === 0}
              className="h-8 gap-1 rounded-lg bg-sky-600 px-3 text-[11px] hover:bg-sky-700 disabled:opacity-40"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              Добавить
            </Button>
          </div>
          {freeNotes.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {freeNotes.map((n) => (
                <li
                  key={n.id}
                  className="flex items-start gap-1.5 rounded-md bg-sky-50/70 px-2 py-1 text-[11px] text-sky-900 ring-1 ring-sky-100"
                >
                  <span className="text-[10px] font-mono text-sky-500">
                    {formatClock(n.ts)}
                  </span>
                  <span className="flex-1 whitespace-pre-wrap">{n.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* Summary — visible once the post-meeting event lands */}
        {summary ? (
          <div className="rounded-xl border border-slate-100 bg-white/80 p-2">
            <InterviewSummaryDisplay
              summary={summary}
              title="Итог интервью"
              defaultOpen={false}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
