"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilterX, Languages, Loader2, Mic2, RotateCw, Users, Volume2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type VoiceRow = { voiceId: string; name: string; labels?: Record<string, string> };

/** Короткая демо-фраза для предпрослушивания TTS выбранного голоса (тот же прокси, что и в сессии). */
const VOICE_PREVIEW_SAMPLE_TEXT = "Hello i am Digital Employee by NULLXES NICE TO MEET YOU";

const LANG_OPTIONS: { id: string; label: string }[] = [
  { id: "any", label: "Все" },
  { id: "en", label: "English" },
  { id: "ru", label: "Русский" },
  { id: "de", label: "Deutsch" },
  { id: "fr", label: "Français" },
  { id: "es", label: "Español" },
  { id: "it", label: "Italiano" },
  { id: "pt", label: "Português" },
  { id: "pl", label: "Polski" },
  { id: "uk", label: "Українська" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
  { id: "zh", label: "中文" },
  { id: "ar", label: "العربية" },
  { id: "tr", label: "Türkçe" },
  { id: "nl", label: "Nederlands" }
];

const GENDER_OPTIONS: { id: string; label: string }[] = [
  { id: "any", label: "Все" },
  { id: "female", label: "Женский" },
  { id: "male", label: "Мужский" },
  { id: "neutral", label: "Нейтр." }
];

type Props = {
  committedVoiceId: string;
  onSave: (voiceId: string) => void;
  className?: string;
};

function labelBadges(labels: Record<string, string> | undefined): { key: string; text: string }[] {
  if (!labels) return [];
  const priority = ["gender", "language", "accent", "age", "use case", "descriptive"];
  const out: { key: string; text: string }[] = [];
  for (const key of priority) {
    const raw = labels[key];
    if (typeof raw === "string" && raw.trim()) {
      out.push({ key, text: raw.trim() });
    }
  }
  for (const [key, val] of Object.entries(labels)) {
    if (priority.includes(key)) continue;
    if (typeof val === "string" && val.trim() && out.length < 5) {
      out.push({ key, text: val.trim() });
    }
  }
  return out.slice(0, 4);
}

export function HrElevenLabsVoicePicker({ committedVoiceId, onSave, className }: Props) {
  const [editing, setEditing] = useState(false);
  const [draftVoiceId, setDraftVoiceId] = useState(committedVoiceId);
  const [search, setSearch] = useState("");
  const [filterLang, setFilterLang] = useState("any");
  const [filterGender, setFilterGender] = useState("any");
  const [voices, setVoices] = useState<VoiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const fetchSeqRef = useRef(0);

  const stopPreview = useCallback(() => {
    const audio = previewAudioRef.current;
    if (!audio) return;
    try {
      audio.pause();
    } catch {
      /* noop */
    }
    const src = audio.src;
    if (src.startsWith("blob:")) {
      URL.revokeObjectURL(src);
    }
    audio.removeAttribute("src");
    audio.load();
    previewAudioRef.current = null;
  }, []);

  const playPreview = useCallback(
    async (voiceId: string) => {
      const id = voiceId.trim();
      if (!id) return;
      stopPreview();
      setPreviewBusy(true);
      try {
        const res = await fetch("/api/tts/elevenlabs/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            text: VOICE_PREVIEW_SAMPLE_TEXT.slice(0, 8000),
            voiceId: id
          })
        });
        if (!res.ok) {
          if (res.status === 503) {
            toast.error("TTS недоступен", { description: "На сервере не задан ELEVENLABS_API_KEY." });
          } else {
            toast.error("Не удалось получить демо-аудио", { description: `HTTP ${res.status}` });
          }
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio();
        previewAudioRef.current = audio;
        audio.src = url;
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            URL.revokeObjectURL(url);
            if (previewAudioRef.current === audio) {
              previewAudioRef.current = null;
            }
          };
          audio.onended = () => {
            cleanup();
            resolve();
          };
          audio.onerror = () => {
            cleanup();
            reject(new Error("preview_audio_error"));
          };
          void audio.play().catch((err) => {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        });
      } catch {
        toast.error("Не удалось воспроизвести демо");
      } finally {
        setPreviewBusy(false);
      }
    },
    [stopPreview]
  );

  useEffect(() => {
    return () => {
      stopPreview();
    };
  }, [stopPreview]);

  useEffect(() => {
    if (!editing) {
      setDraftVoiceId(committedVoiceId);
    }
  }, [committedVoiceId, editing]);

  const fetchVoices = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      const q = search.trim();
      if (q.length > 0) params.set("q", q);
      if (filterLang !== "any") params.set("lang", filterLang);
      if (filterGender !== "any") params.set("gender", filterGender);
      const qs = params.toString();
      const url = qs.length > 0 ? `/api/elevenlabs/voices?${qs}` : "/api/elevenlabs/voices";
      const res = await fetch(url);
      const data = (await res.json()) as { voices?: VoiceRow[]; error?: string };
      if (seq !== fetchSeqRef.current) return;
      if (!res.ok) {
        setError(data.error === "elevenlabs_not_configured" ? "no_api_key" : (data.error ?? "load_failed"));
        setVoices([]);
        return;
      }
      setVoices(Array.isArray(data.voices) ? data.voices : []);
    } catch {
      if (seq !== fetchSeqRef.current) return;
      setError("network");
      setVoices([]);
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  }, [search, filterLang, filterGender]);

  useEffect(() => {
    if (!editing) {
      return;
    }
    const t = window.setTimeout(() => {
      void fetchVoices();
    }, 280);
    return () => window.clearTimeout(t);
  }, [editing, fetchVoices]);

  const resetFiltersAndSearch = useCallback(() => {
    setSearch("");
    setFilterLang("any");
    setFilterGender("any");
  }, []);

  const selectRows = useMemo(() => {
    const byId = new Map<string, VoiceRow>();
    for (const v of voices) {
      byId.set(v.voiceId, v);
    }
    const d = draftVoiceId.trim();
    if (d && !byId.has(d)) {
      byId.set(d, { voiceId: d, name: d });
    }
    const c = committedVoiceId.trim();
    if (c && !byId.has(c)) {
      byId.set(c, { voiceId: c, name: c });
    }
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [voices, draftVoiceId, committedVoiceId]);

  const committedLabel = useMemo(() => {
    const hit = voices.find((v) => v.voiceId === committedVoiceId.trim());
    if (hit) return `${hit.name}`;
    const short = committedVoiceId.trim();
    if (!short) return "—";
    return short.length > 14 ? `${short.slice(0, 6)}…${short.slice(-4)}` : short;
  }, [voices, committedVoiceId]);

  const draftDisplayName = useMemo(() => {
    const id = draftVoiceId.trim();
    if (!id) return "Не выбран";
    const row = selectRows.find((v) => v.voiceId === id);
    if (row && row.name !== row.voiceId) return row.name;
    return row?.name ?? id;
  }, [selectRows, draftVoiceId]);

  const chipClass = (active: boolean) =>
    cn(
      "shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium transition-all active:scale-[0.98]",
      active
        ? "bg-slate-800 text-white shadow-sm ring-1 ring-slate-800/20"
        : "bg-white/90 text-slate-600 shadow-sm ring-1 ring-slate-200/80 hover:bg-white hover:ring-slate-300"
    );

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-2xl border border-sky-200/35 bg-gradient-to-br from-white via-white to-sky-50/50 p-3.5 text-xs text-slate-600 shadow-sm ring-1 ring-white/70",
        className
      )}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 gap-2.5">
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-sky-600 text-white shadow-md shadow-sky-500/25"
            aria-hidden
          >
            <Mic2 className="size-4" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-slate-800">Голос ассистента</span>
              <span className="rounded-full bg-sky-100/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-900">
                ElevenLabs
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Выберите тембр из каталога, при необходимости отфильтруйте язык и пол, нажмите «Прослушать демо» и сохраните.
            </p>
          </div>
        </div>
        {!editing ? (
          <div className="flex w-full shrink-0 gap-2 sm:ml-auto sm:w-auto">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-10 min-h-10 flex-1 gap-1.5 rounded-xl px-3 text-[11px] shadow-sm sm:h-9 sm:min-h-9 sm:flex-initial"
              title={VOICE_PREVIEW_SAMPLE_TEXT}
              disabled={previewBusy || !committedVoiceId.trim()}
              onClick={() => void playPreview(committedVoiceId)}
            >
              {previewBusy ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : <Volume2 className="size-3.5 shrink-0" aria-hidden />}
              Демо
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-10 min-h-10 flex-1 rounded-xl px-3 text-[11px] shadow-sm sm:h-9 sm:min-h-9 sm:flex-initial"
              onClick={() => setEditing(true)}
            >
              Изменить
            </Button>
          </div>
        ) : (
          <div className="flex w-full shrink-0 justify-end gap-1 sm:ml-auto sm:w-auto">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-10 min-h-10 rounded-xl px-3 text-[11px] sm:h-9 sm:min-h-9"
              onClick={() => {
                stopPreview();
                setEditing(false);
                setDraftVoiceId(committedVoiceId);
                resetFiltersAndSearch();
              }}
            >
              Отмена
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-10 min-h-10 rounded-xl px-4 text-[11px] font-semibold sm:h-9 sm:min-h-9"
              disabled={!draftVoiceId.trim()}
              onClick={() => {
                const next = draftVoiceId.trim();
                if (!next) return;
                stopPreview();
                onSave(next);
                setEditing(false);
                resetFiltersAndSearch();
              }}
            >
              Сохранить
            </Button>
          </div>
        )}
      </div>

      {!editing ? (
        <div className="rounded-xl border border-slate-200/90 bg-white/70 px-3 py-2.5 shadow-inner">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Сейчас выбрано</p>
          <p className="mt-1 truncate text-sm font-semibold text-slate-800" title={committedLabel}>
            {committedLabel}
          </p>
          <p className="mt-1 break-all font-mono text-[10px] leading-snug text-slate-500" title={committedVoiceId}>
            {committedVoiceId.trim() || "—"}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по имени или описанию…"
              className="h-10 min-h-10 rounded-xl border-slate-200/90 bg-white/90 pr-17 text-xs shadow-inner sm:h-9 sm:min-h-9 sm:pr-20"
            />
            <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5">
              <div className="pointer-events-auto flex items-center gap-0.5 rounded-md bg-white/80 p-0.5 shadow-sm ring-1 ring-slate-200/60 backdrop-blur-[2px]">
                {search.trim().length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 rounded-md text-slate-500 hover:text-slate-800"
                    title="Очистить поиск"
                    onClick={() => setSearch("")}
                  >
                    <X className="size-3.5" aria-hidden />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-md text-slate-500 hover:text-slate-800"
                  title="Обновить список"
                  disabled={loading}
                  onClick={() => void fetchVoices()}
                >
                  <RotateCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
                </Button>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200/70 bg-slate-50/50 p-2.5 ring-1 ring-slate-100/80">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Фильтры каталога</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 rounded-lg px-2 text-[10px] text-slate-500 hover:bg-white/80 hover:text-slate-800"
                title="Сбросить поиск и фильтры"
                onClick={resetFiltersAndSearch}
              >
                <FilterX className="size-3" aria-hidden />
                Сброс
              </Button>
            </div>
            <div className="space-y-2">
            <div className="space-y-1">
            <div className="flex items-center gap-1 text-[10px] font-medium text-slate-500">
              <Languages className="size-3 shrink-0 opacity-80" aria-hidden />
              Язык
            </div>
            <div className="flex gap-1 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {LANG_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={chipClass(filterLang === opt.id)}
                  onClick={() => {
                    if (opt.id === "any") setFilterLang("any");
                    else setFilterLang((prev) => (prev === opt.id ? "any" : opt.id));
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

            <div className="space-y-1">
            <div className="flex items-center gap-1 text-[10px] font-medium text-slate-500">
              <Users className="size-3 shrink-0 opacity-80" aria-hidden />
              Пол
            </div>
            <div className="flex flex-wrap gap-1">
              {GENDER_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={chipClass(filterGender === opt.id)}
                  onClick={() => {
                    if (opt.id === "any") setFilterGender("any");
                    else setFilterGender((prev) => (prev === opt.id ? "any" : opt.id));
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Загрузка каталога…
            </div>
          ) : null}
          {error === "no_api_key" || error === "elevenlabs_not_configured" ? (
            <p className="rounded-lg border border-rose-200/80 bg-rose-50/80 px-3 py-2 text-[11px] leading-snug text-rose-800">
              Каталог голосов сейчас недоступен: проверьте настройки сервера (ключ ElevenLabs).
            </p>
          ) : error ? (
            <p className="rounded-lg border border-rose-200/80 bg-rose-50/80 px-3 py-2 text-[11px] leading-snug text-rose-800">
              Не удалось загрузить каталог. Попробуйте «Обновить» или смените фильтры.
            </p>
          ) : null}
          {!loading && editing && !error ? (
            <p className="text-[10px] text-slate-400">
              В списке: <span className="font-medium text-slate-600">{selectRows.length}</span>
              {selectRows.length >= 100 ? "+" : ""} голосов
            </p>
          ) : null}

          <div className="rounded-xl border border-slate-200/90 bg-gradient-to-br from-slate-50/90 to-white px-3 py-2.5 shadow-inner">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Выбор</p>
            <p className="mt-0.5 truncate text-sm font-semibold text-slate-800">{draftDisplayName}</p>
            <p className="mt-0.5 break-all font-mono text-[10px] leading-snug text-slate-500">{draftVoiceId.trim() || "—"}</p>
          </div>

          <Select
            value={draftVoiceId.trim() || undefined}
            onValueChange={(v) => {
              if (typeof v === "string" && v.length > 0) {
                setDraftVoiceId(v);
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="h-11 min-h-11 w-full min-w-0 rounded-xl border-slate-200/90 bg-white/95 text-left text-[11px] sm:h-10 sm:min-h-10"
            >
              <SelectValue placeholder="Откройте список и выберите голос…" />
            </SelectTrigger>
            <SelectContent className="max-h-72 rounded-xl">
              {selectRows.length === 0 && !loading && !error ? (
                <p className="px-3 py-4 text-center text-[11px] leading-relaxed text-slate-500">
                  Ничего не нашлось. Смягчите фильтры, нажмите «Сброс» или уточните поиск.
                </p>
              ) : (
                selectRows.map((v) => {
                  const badges = labelBadges(v.labels);
                  return (
                    <SelectItem
                      key={v.voiceId}
                      value={v.voiceId}
                      className="items-start py-2 text-left text-[11px]"
                      title={`${v.name} — ${v.voiceId}`}
                    >
                      <span className="block font-medium text-slate-800">{v.name}</span>
                      <span className="mt-0.5 block font-mono text-[10px] leading-tight text-slate-500">{v.voiceId}</span>
                      {badges.length > 0 ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {badges.map((b) => (
                            <span
                              key={`${v.voiceId}-${b.key}`}
                              className="rounded-md bg-slate-100/90 px-1.5 py-0.5 text-[9px] font-medium text-slate-600"
                            >
                              {b.text}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </SelectItem>
                  );
                })
              )}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            className="h-10 min-h-10 w-full gap-2 rounded-xl border-sky-200/80 bg-sky-50/40 text-[11px] font-medium text-sky-950 hover:bg-sky-50/80 sm:h-9 sm:min-h-9"
            title={VOICE_PREVIEW_SAMPLE_TEXT}
            disabled={previewBusy || !draftVoiceId.trim()}
            onClick={() => void playPreview(draftVoiceId)}
          >
            {previewBusy ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : <Volume2 className="size-3.5 shrink-0" aria-hidden />}
            Прослушать демо
          </Button>
        </div>
      )}
    </div>
  );
}
