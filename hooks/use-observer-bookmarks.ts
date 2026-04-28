"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export type ObserverBookmarkTag = "question" | "answer" | "issue" | "highlight" | null;
export type ObserverBookmarkSpeaker = "candidate" | "agent" | "unknown";

export type ObserverBookmark = {
  id: string;
  meetingId: string;
  createdAt: number;
  sessionOffsetMs: number;
  note: string;
  thumbnailDataUrl?: string;
  speaker?: ObserverBookmarkSpeaker;
  tag?: ObserverBookmarkTag;
};

const MAX_BOOKMARKS_PER_MEETING = 200;

type UseObserverBookmarksInput = {
  meetingId: string | null;
  enabled: boolean;
  sessionStartedAt: number | null;
  resolveCandidateVideoElement: () => HTMLVideoElement | null;
  resolveSpeaker?: () => ObserverBookmarkSpeaker;
};

type UseObserverBookmarksResult = {
  bookmarks: ObserverBookmark[];
  loading: boolean;
  inputFocusNonce: number;
  createBookmark: (note?: string) => Promise<ObserverBookmark | null>;
  createAndFocusInput: () => Promise<ObserverBookmark | null>;
  downloadCurrentFrame: () => Promise<void>;
  updateBookmark: (id: string, patch: Pick<ObserverBookmark, "note" | "tag" | "speaker">) => void;
  deleteBookmark: (id: string) => void;
  exportBookmarks: () => void;
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("[contenteditable='true']"));
}

function formatOffsetLabel(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function createCanvasSnapshot(video: HTMLVideoElement): string | null {
  if (video.videoWidth <= 0 || video.videoHeight <= 0 || video.readyState < 2) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 135;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
}

export function useObserverBookmarks({
  meetingId,
  enabled,
  sessionStartedAt,
  resolveCandidateVideoElement,
  resolveSpeaker
}: UseObserverBookmarksInput): UseObserverBookmarksResult {
  const [bookmarks, setBookmarks] = useState<ObserverBookmark[]>([]);
  const [loading, setLoading] = useState(false);
  const [inputFocusNonce, setInputFocusNonce] = useState(0);
  const storageKey = useMemo(
    () => (meetingId ? `nullxes:spectator:bookmarks:${meetingId}` : null),
    [meetingId]
  );
  const bookmarksRef = useRef<ObserverBookmark[]>([]);

  useEffect(() => {
    bookmarksRef.current = bookmarks;
  }, [bookmarks]);

  const persist = useCallback(
    (next: ObserverBookmark[]) => {
      setBookmarks(next);
      if (!storageKey || typeof window === "undefined") return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        toast.error("Не удалось сохранить локальные заметки наблюдателя");
      }
    },
    [storageKey]
  );

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") {
      setBookmarks([]);
      return;
    }
    setLoading(true);
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        setBookmarks([]);
        return;
      }
      const parsed = JSON.parse(raw) as ObserverBookmark[];
      const normalized = Array.isArray(parsed)
        ? parsed.filter((item) => item && item.meetingId === meetingId).slice(-MAX_BOOKMARKS_PER_MEETING)
        : [];
      setBookmarks(normalized);
    } catch {
      setBookmarks([]);
    } finally {
      setLoading(false);
    }
  }, [meetingId, storageKey]);

  const createBookmark = useCallback(
    async (note = ""): Promise<ObserverBookmark | null> => {
      if (!meetingId || !enabled) return null;
      const startedAt = sessionStartedAt ?? Date.now();
      const sessionOffsetMs = Math.max(0, Date.now() - startedAt);
      const video = resolveCandidateVideoElement();
      const thumbnailDataUrl = video ? createCanvasSnapshot(video) ?? undefined : undefined;
      if (!thumbnailDataUrl) {
        toast.info("Кадр недоступен: дождитесь видео кандидата");
      }
      const id = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `bm-${Date.now()}`;
      const created: ObserverBookmark = {
        id,
        meetingId,
        createdAt: Date.now(),
        sessionOffsetMs,
        note: note.trim(),
        thumbnailDataUrl,
        speaker: resolveSpeaker?.() ?? "unknown",
        tag: null
      };
      const next = [...bookmarksRef.current, created].sort((a, b) => a.createdAt - b.createdAt);
      if (next.length > MAX_BOOKMARKS_PER_MEETING) {
        const evicted = next.length - MAX_BOOKMARKS_PER_MEETING;
        toast.warning(`Лимит ${MAX_BOOKMARKS_PER_MEETING} заметок: удалено старых ${evicted}`);
      }
      persist(next.slice(-MAX_BOOKMARKS_PER_MEETING));
      toast.success(`Метка добавлена (${formatOffsetLabel(sessionOffsetMs)})`);
      return created;
    },
    [enabled, meetingId, persist, resolveCandidateVideoElement, resolveSpeaker, sessionStartedAt]
  );

  const createAndFocusInput = useCallback(async (): Promise<ObserverBookmark | null> => {
    const created = await createBookmark("");
    setInputFocusNonce((prev) => prev + 1);
    return created;
  }, [createBookmark]);

  const downloadCurrentFrame = useCallback(async () => {
    if (!enabled) return;
    const video = resolveCandidateVideoElement();
    if (!video) {
      toast.info("Видео кандидата недоступно для скриншота");
      return;
    }
    const imageData = createCanvasSnapshot(video);
    if (!imageData) {
      toast.info("Не удалось захватить кадр");
      return;
    }
    const a = document.createElement("a");
    const suffix = meetingId ? `-${meetingId}` : "";
    a.href = imageData;
    a.download = `observer-frame${suffix}-${Date.now()}.jpg`;
    a.click();
    toast.success("Кадр сохранён");
  }, [enabled, meetingId, resolveCandidateVideoElement]);

  const updateBookmark = useCallback(
    (id: string, patch: Pick<ObserverBookmark, "note" | "tag" | "speaker">) => {
      const next = bookmarksRef.current.map((item) => (item.id === id ? { ...item, ...patch } : item));
      persist(next);
    },
    [persist]
  );

  const deleteBookmark = useCallback(
    (id: string) => {
      const next = bookmarksRef.current.filter((item) => item.id !== id);
      persist(next);
      toast.success("Метка удалена");
    },
    [persist]
  );

  const exportBookmarks = useCallback(() => {
    if (!meetingId) return;
    const payload = {
      meetingId,
      exportedAt: new Date().toISOString(),
      bookmarks: bookmarksRef.current
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `observer-bookmarks-${meetingId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [meetingId]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "m") {
        event.preventDefault();
        void createBookmark();
      }
      if (key === "n") {
        event.preventDefault();
        void createAndFocusInput();
      }
      if (key === "s") {
        event.preventDefault();
        void downloadCurrentFrame();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [createAndFocusInput, createBookmark, downloadCurrentFrame, enabled]);

  return {
    bookmarks,
    loading,
    inputFocusNonce,
    createBookmark,
    createAndFocusInput,
    downloadCurrentFrame,
    updateBookmark,
    deleteBookmark,
    exportBookmarks
  };
}

