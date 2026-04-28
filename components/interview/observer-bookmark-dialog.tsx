"use client";

import { useState } from "react";
import Image from "next/image";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { ObserverBookmark, ObserverBookmarkSpeaker, ObserverBookmarkTag } from "@/hooks/use-observer-bookmarks";

type ObserverBookmarkDialogProps = {
  open: boolean;
  bookmark: ObserverBookmark | null;
  onOpenChange: (next: boolean) => void;
  onSave: (id: string, patch: Pick<ObserverBookmark, "note" | "tag" | "speaker">) => void;
};

const TAG_OPTIONS: Array<{ label: string; value: ObserverBookmarkTag }> = [
  { label: "Без тега", value: null },
  { label: "Вопрос", value: "question" },
  { label: "Ответ", value: "answer" },
  { label: "Проблема", value: "issue" },
  { label: "Хайлайт", value: "highlight" }
];

const SPEAKER_OPTIONS: Array<{ label: string; value: ObserverBookmarkSpeaker }> = [
  { label: "Кандидат", value: "candidate" },
  { label: "HR агент", value: "agent" },
  { label: "Неизвестно", value: "unknown" }
];

function formatOffset(offsetMs: number): string {
  const total = Math.max(0, Math.floor(offsetMs / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function ObserverBookmarkDialog({ open, bookmark, onOpenChange, onSave }: ObserverBookmarkDialogProps) {
  const [note, setNote] = useState(bookmark?.note ?? "");
  const [tag, setTag] = useState<ObserverBookmarkTag>(bookmark?.tag ?? null);
  const [speaker, setSpeaker] = useState<ObserverBookmarkSpeaker>(bookmark?.speaker ?? "unknown");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Детали заметки</DialogTitle>
        </DialogHeader>
        {bookmark ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <Badge variant="secondary">T+ {formatOffset(bookmark.sessionOffsetMs)}</Badge>
              <Badge variant="outline">{speaker}</Badge>
              {tag ? <Badge variant="outline">{tag}</Badge> : null}
            </div>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
              {bookmark.thumbnailDataUrl ? (
                <Image
                  src={bookmark.thumbnailDataUrl}
                  alt="Bookmark thumbnail"
                  width={480}
                  height={270}
                  unoptimized
                  className="h-[270px] w-full object-cover"
                />
              ) : (
                <div className="flex h-[270px] items-center justify-center text-sm text-slate-500">Кадр недоступен</div>
              )}
            </div>
            <Separator />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-700">Тег</p>
                <div className="flex flex-wrap gap-2">
                  {TAG_OPTIONS.map((item) => (
                    <Button
                      key={item.label}
                      type="button"
                      size="sm"
                      variant={tag === item.value ? "default" : "outline"}
                      onClick={() => setTag(item.value)}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-700">Спикер</p>
                <div className="flex flex-wrap gap-2">
                  {SPEAKER_OPTIONS.map((item) => (
                    <Button
                      key={item.value}
                      type="button"
                      size="sm"
                      variant={speaker === item.value ? "default" : "outline"}
                      onClick={() => setSpeaker(item.value)}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-700">Заметка</p>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={5} />
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  onSave(bookmark.id, { note, tag, speaker });
                  onOpenChange(false);
                }}
              >
                Сохранить
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

