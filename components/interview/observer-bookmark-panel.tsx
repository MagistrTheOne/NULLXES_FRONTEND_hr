"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Download, Flag, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ObserverBookmarkDialog } from "@/components/interview/observer-bookmark-dialog";
import type { ObserverBookmark } from "@/hooks/use-observer-bookmarks";

type ObserverBookmarkPanelProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  bookmarks: ObserverBookmark[];
  loading: boolean;
  inputFocusNonce: number;
  onCreateBookmark: (note?: string) => Promise<ObserverBookmark | null>;
  onDeleteBookmark: (id: string) => void;
  onUpdateBookmark: (id: string, patch: Pick<ObserverBookmark, "note" | "tag" | "speaker">) => void;
  onExport: () => void;
};

function formatOffset(offsetMs: number): string {
  const total = Math.max(0, Math.floor(offsetMs / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function ObserverBookmarkPanel({
  open,
  onOpenChange,
  bookmarks,
  loading,
  inputFocusNonce,
  onCreateBookmark,
  onDeleteBookmark,
  onUpdateBookmark,
  onExport
}: ObserverBookmarkPanelProps) {
  const [quickNote, setQuickNote] = useState("");
  const [activeBookmarkId, setActiveBookmarkId] = useState<string | null>(null);
  const quickInputRef = useRef<HTMLInputElement | null>(null);
  const activeBookmark = useMemo(
    () => bookmarks.find((item) => item.id === activeBookmarkId) ?? null,
    [activeBookmarkId, bookmarks]
  );

  useEffect(() => {
    if (inputFocusNonce <= 0) return;
    quickInputRef.current?.focus();
  }, [inputFocusNonce]);

  return (
    <>
      <aside
        className={`rounded-2xl border border-slate-200 bg-white/80 shadow-sm transition-all ${open ? "w-full p-3 xl:w-[360px]" : "w-auto p-2"}`}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-800">Таймлайн наблюдателя</p>
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="sm" onClick={onExport} title="Экспорт JSON">
              <Download className="h-4 w-4" />
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(!open)}>
              {open ? "Свернуть" : "Открыть"}
            </Button>
          </div>
        </div>
        {open ? (
          <>
            <div className="mt-2 flex items-center gap-2">
              <Input
                ref={quickInputRef}
                value={quickNote}
                onChange={(event) => setQuickNote(event.target.value)}
                placeholder="Быстрая заметка (N фокусирует это поле)"
              />
              <Button
                type="button"
                onClick={() => {
                  void onCreateBookmark(quickNote);
                  setQuickNote("");
                }}
              >
                <Flag className="mr-1 h-4 w-4" />
                Маркер
              </Button>
            </div>
            <Separator className="my-3" />
            <ScrollArea className="h-[320px] pr-2">
              {loading ? <p className="text-xs text-slate-500">Загрузка локальных меток...</p> : null}
              {!loading && bookmarks.length === 0 ? (
                <p className="text-xs text-slate-500">Пока нет меток. Нажми M для quick mark.</p>
              ) : null}
              <div className="space-y-2">
                {bookmarks
                  .slice()
                  .reverse()
                  .map((bookmark) => (
                    <div key={bookmark.id} className="rounded-xl border border-slate-200 bg-white p-2">
                      <button
                        type="button"
                        className="flex w-full items-start gap-2 text-left"
                        onClick={() => setActiveBookmarkId(bookmark.id)}
                      >
                        <div className="h-[54px] w-24 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-100">
                          {bookmark.thumbnailDataUrl ? (
                            <Image
                              src={bookmark.thumbnailDataUrl}
                              alt="Bookmark thumbnail"
                              width={240}
                              height={135}
                              unoptimized
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-[10px] text-slate-500">No frame</div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant="secondary">T+ {formatOffset(bookmark.sessionOffsetMs)}</Badge>
                            <Badge variant="outline">{bookmark.speaker ?? "unknown"}</Badge>
                            {bookmark.tag ? <Badge variant="outline">{bookmark.tag}</Badge> : null}
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-slate-700">
                            {bookmark.note?.trim() ? bookmark.note : "Без заметки"}
                          </p>
                        </div>
                      </button>
                      <div className="mt-2 flex justify-end gap-1">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setActiveBookmarkId(bookmark.id)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => onDeleteBookmark(bookmark.id)}>
                          <Trash2 className="h-4 w-4 text-rose-600" />
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            </ScrollArea>
          </>
        ) : null}
      </aside>
      <ObserverBookmarkDialog
        key={activeBookmark?.id ?? "none"}
        open={Boolean(activeBookmark)}
        bookmark={activeBookmark}
        onOpenChange={(next) => {
          if (!next) setActiveBookmarkId(null);
        }}
        onSave={onUpdateBookmark}
      />
    </>
  );
}

