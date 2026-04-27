"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilterX, Loader2, Mic2, RotateCw, Square, Volume2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type VoiceRow = { voiceId: string; name: string; labels?: Record<string, string> };

/**
 * Короткая демо-фраза для предпрослушивания TTS выбранного голоса (тот же прокси, что и в сессии).
 * Русский текст — чтобы превью совпадало с тем, как ассистент звучит для кандидата.
 */
const VOICE_PREVIEW_SAMPLE_TEXT =
  "Привет! Я цифровой HR JobAI на базе NULLXES. Приятно познакомиться — расскажу о вакансии, компании и дальнейших шагах.";

const LANG_OPTIONS: { id: string; label: string }[] = [
  { id: "any", label: "Все языки" },
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
  { id: "any", label: "Любой пол" },
  { id: "female", label: "Женский" },
  { id: "male", label: "Мужской" },
  { id: "neutral", label: "Нейтральный" }
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

/** Человекочитаемое имя без показа технического voice_id. */
function friendlyVoiceLabel(row: VoiceRow): string {
  const n = row.name.trim();
  if (n && n !== row.voiceId) return n;
  return "Голос без названия";
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
  type PreviewPhase = "idle" | "loading" | "playing";
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>("idle");
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewGenRef = useRef(0);
  const fetchSeqRef = useRef(0);

  const stopPreview = useCallback(() => {
    previewGenRef.current += 1;
    const audio = previewAudioRef.current;
    if (audio) {
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
    }
    setPreviewPhase("idle");
  }, []);

  const playPreview = useCallback(
    async (voiceId: string) => {
      const id = voiceId.trim();
      if (!id) return;
      stopPreview();
      const gen = previewGenRef.current;
      setPreviewPhase("loading");
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
        if (previewGenRef.current !== gen) return;
        if (!res.ok) {
          if (res.status === 503) {
            toast.error("TTS недоступен", { description: "На сервере не задан ключ ElevenLabs." });
          } else {
            toast.error("Не удалось получить демо-аудио", { description: `HTTP ${res.status}` });
          }
          setPreviewPhase("idle");
          return;
        }
        const blob = await res.blob();
        if (previewGenRef.current !== gen) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio();
        previewAudioRef.current = audio;
        audio.src = url;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (previewAudioRef.current === audio) {
            previewAudioRef.current = null;
          }
          if (previewGenRef.current === gen) {
            setPreviewPhase("idle");
          }
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          if (previewAudioRef.current === audio) {
            previewAudioRef.current = null;
          }
          if (previewGenRef.current === gen) {
            setPreviewPhase("idle");
            toast.error("Не удалось воспроизвести демо");
          }
        };
        await audio.play();
        if (previewGenRef.current !== gen) {
          try {
            audio.pause();
          } catch {
            /* noop */
          }
          URL.revokeObjectURL(url);
          if (previewAudioRef.current === audio) {
            previewAudioRef.current = null;
          }
          return;
        }
        setPreviewPhase("playing");
      } catch {
        if (previewGenRef.current === gen) {
          toast.error("Не удалось воспроизвести демо");
          setPreviewPhase("idle");
        }
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
    }, 220);
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
    return Array.from(byId.values()).sort((a, b) =>
      friendlyVoiceLabel(a).localeCompare(friendlyVoiceLabel(b), "ru")
    );
  }, [voices, draftVoiceId, committedVoiceId]);

  const committedLabel = useMemo(() => {
    const id = committedVoiceId.trim();
    if (!id) return "—";
    const hit = voices.find((v) => v.voiceId === id);
    if (hit) return friendlyVoiceLabel(hit);
    return "Сохранённый голос";
  }, [voices, committedVoiceId]);

  return (
    <TooltipProvider delay={400}>
      <div
        className={cn(
          "flex min-w-0 flex-col gap-2 rounded-xl border border-sky-200/40 bg-gradient-to-br from-white via-white to-sky-50/40 p-2.5 text-xs text-slate-600 shadow-sm ring-1 ring-white/60",
          className
        )}
      >
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 gap-2">
            <Tooltip>
              <TooltipTrigger
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-sky-600 text-white shadow-sm shadow-sky-500/20"
                aria-label="Подсказка по выбору голоса"
              >
                <Mic2 className="size-3.5" strokeWidth={2} aria-hidden />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px] text-xs leading-snug">
                Выберите голос в списке, при необходимости сузьте язык и пол, прослушайте демо и нажмите «Сохранить».
              </TooltipContent>
            </Tooltip>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-semibold tracking-tight text-slate-800">Голос ассистента</span>
                <Badge variant="secondary" className="h-5 px-1.5 text-[9px] font-semibold uppercase tracking-wide">
                  ElevenLabs
                </Badge>
              </div>
              {!editing ? (
                <p className="mt-0.5 line-clamp-1 text-[10px] leading-tight text-slate-500">
                  Тембр озвучки ассистента для этого интервью.
                </p>
              ) : (
                <p className="mt-0.5 line-clamp-1 text-[10px] leading-tight text-slate-500">
                  Список → демо → «Сохранить».
                </p>
              )}
            </div>
          </div>
          {!editing ? (
            <div className="flex w-full shrink-0 gap-1.5 sm:ml-auto sm:w-auto">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-9 min-h-9 flex-1 gap-1 rounded-lg px-2.5 text-[11px] sm:flex-initial"
                title={VOICE_PREVIEW_SAMPLE_TEXT}
                disabled={previewPhase !== "idle" || !committedVoiceId.trim()}
                onClick={() => void playPreview(committedVoiceId)}
              >
                {previewPhase === "loading" ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <Volume2 className="size-3.5 shrink-0" aria-hidden />
                )}
                {previewPhase === "loading" ? "…" : "Демо"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 min-h-9 shrink-0 gap-1 rounded-lg px-2.5 text-[11px]"
                title="Остановить демо"
                disabled={previewPhase !== "playing"}
                onClick={stopPreview}
              >
                <Square className="size-2.5 fill-current" aria-hidden />
                Стоп
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="h-9 min-h-9 flex-1 rounded-lg px-2.5 text-[11px] sm:flex-initial"
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
                className="h-9 min-h-9 rounded-lg px-2.5 text-[11px]"
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
                className="h-9 min-h-9 rounded-lg px-3 text-[11px] font-semibold"
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
          <div className="rounded-lg border border-slate-200/80 bg-white/80 px-2.5 py-2 shadow-inner">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Сейчас</p>
            <p className="mt-0.5 truncate text-sm font-semibold text-slate-800" title={committedLabel}>
              {committedLabel}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск по имени голоса…"
                className="h-9 min-h-9 rounded-lg border-slate-200/90 bg-white/95 pr-14 text-xs shadow-inner"
                aria-label="Поиск по каталогу ElevenLabs"
              />
              <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center">
                <div className="pointer-events-auto flex items-center rounded-md bg-white/90 p-0.5 shadow-sm ring-1 ring-slate-200/50">
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

            <div className="flex flex-wrap items-end gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
                <div className="grid min-w-0 gap-1">
                  <Label htmlFor="hr-el-lang" className="text-[10px] font-medium text-slate-500">
                    Язык
                  </Label>
                  <NativeSelect
                    id="hr-el-lang"
                    size="sm"
                    className="w-full min-w-0"
                    value={filterLang}
                    onChange={(e) => setFilterLang(e.target.value)}
                  >
                    {LANG_OPTIONS.map((opt) => (
                      <NativeSelectOption key={opt.id} value={opt.id}>
                        {opt.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="grid min-w-0 gap-1">
                  <Label htmlFor="hr-el-gender" className="text-[10px] font-medium text-slate-500">
                    Пол
                  </Label>
                  <NativeSelect
                    id="hr-el-gender"
                    size="sm"
                    className="w-full min-w-0"
                    value={filterGender}
                    onChange={(e) => setFilterGender(e.target.value)}
                  >
                    {GENDER_OPTIONS.map((opt) => (
                      <NativeSelectOption key={opt.id} value={opt.id}>
                        {opt.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-9 shrink-0 rounded-lg"
                title="Сбросить поиск и фильтры"
                onClick={resetFiltersAndSearch}
              >
                <FilterX className="size-3.5" aria-hidden />
              </Button>
            </div>

            <div className="flex min-h-[18px] flex-wrap items-center gap-2 text-[10px] text-slate-400">
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  Загрузка…
                </span>
              ) : !error ? (
                <span>
                  В списке:{" "}
                  <span className="font-medium text-slate-600 tabular-nums">{selectRows.length}</span>
                  {selectRows.length >= 100 ? "+" : ""}
                </span>
              ) : null}
            </div>

            {error === "no_api_key" || error === "elevenlabs_not_configured" ? (
              <p className="rounded-md border border-rose-200/80 bg-rose-50/80 px-2.5 py-1.5 text-[11px] leading-snug text-rose-800">
                Каталог недоступен. Проверьте настройки сервера (ключ ElevenLabs).
              </p>
            ) : error ? (
              <p className="rounded-md border border-rose-200/80 bg-rose-50/80 px-2.5 py-1.5 text-[11px] leading-snug text-rose-800">
                Не удалось загрузить каталог. Попробуйте «Обновить» или смените фильтры.
              </p>
            ) : null}

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
                className="h-9 min-h-9 w-full min-w-0 rounded-lg border-slate-200/90 bg-white/95 text-left text-xs"
              >
                <SelectValue placeholder="Выберите голос…" />
              </SelectTrigger>
              <SelectContent className="max-h-60 rounded-lg text-xs" align="start" sideOffset={4}>
                {selectRows.length === 0 && !loading && !error ? (
                  <p className="px-2.5 py-3 text-center text-[11px] leading-relaxed text-slate-500">
                    Ничего не нашлось. Сбросьте фильтры или уточните поиск.
                  </p>
                ) : (
                  selectRows.map((v) => {
                    const badges = labelBadges(v.labels).slice(0, 2);
                    const label = friendlyVoiceLabel(v);
                    return (
                      <SelectItem
                        key={v.voiceId}
                        value={v.voiceId}
                        className="py-1.5 pr-7 text-left text-xs"
                        title={label}
                      >
                        <span className="flex min-w-0 max-w-[min(100vw-4rem,20rem)] items-center gap-1.5">
                          <span className="truncate font-medium text-slate-800">{label}</span>
                          {badges.map((b) => (
                            <Badge
                              key={`${v.voiceId}-${b.key}`}
                              variant="outline"
                              className="inline-flex h-4 max-w-[4.5rem] shrink-0 truncate px-1 py-0 text-[9px] font-normal"
                            >
                              {b.text}
                            </Badge>
                          ))}
                        </span>
                      </SelectItem>
                    );
                  })
                )}
              </SelectContent>
            </Select>

            <div className="flex gap-1.5">
              <Button
                type="button"
                variant="outline"
                className="h-9 min-h-9 min-w-0 flex-1 gap-1.5 rounded-lg border-sky-200/70 bg-sky-50/30 text-[11px] font-medium text-sky-950"
                title={VOICE_PREVIEW_SAMPLE_TEXT}
                disabled={previewPhase !== "idle" || !draftVoiceId.trim()}
                onClick={() => void playPreview(draftVoiceId)}
              >
                {previewPhase === "loading" ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                ) : (
                  <Volume2 className="size-3.5 shrink-0" aria-hidden />
                )}
                {previewPhase === "loading" ? "Загрузка…" : "Прослушать демо"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9 min-h-9 shrink-0 gap-1 rounded-lg px-2.5 text-[11px]"
                title="Остановить демо"
                disabled={previewPhase !== "playing"}
                onClick={stopPreview}
              >
                <Square className="size-2.5 fill-current" aria-hidden />
                Стоп
              </Button>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
