"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, FilterX, Loader2, Mic2, Pencil, RotateCw, Square, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor
} from "@/components/ui/combobox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type VoiceRow = { voiceId: string; name: string; labels?: Record<string, string> };

const VOICE_PREVIEW_SAMPLE_TEXT =
  "Привет! Я цифровой HR JobAI на базе NULLXES. Приятно познакомиться — расскажу о вакансии, компании и дальнейших шагах.";

type VoiceStyleFilter = "any" | "neutral" | "confident" | "soft" | "energetic" | "premium";

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

const STYLE_OPTIONS: { id: VoiceStyleFilter; label: string }[] = [
  { id: "any", label: "Все стили" },
  { id: "neutral", label: "Нейтральный" },
  { id: "confident", label: "Уверенный" },
  { id: "soft", label: "Мягкий" },
  { id: "energetic", label: "Энергичный" },
  { id: "premium", label: "Премиальный" }
];

type Props = {
  committedVoiceId: string;
  onSave: (voiceId: string) => void;
  className?: string;
};

function getVoiceDisplayName(voice: VoiceRow): string {
  const raw = (voice.name ?? "").trim();
  if (!raw) return "Без названия";
  const parts = raw.split(" - ");
  const head = (parts[0] ?? "").trim();
  // If the catalog stores only an ID in name — keep it, but still humanize a bit.
  if (!head) return "Без названия";
  return head;
}

function getVoiceLanguageLabel(voice: VoiceRow): string | null {
  const raw = (voice.labels?.language ?? voice.labels?.lang ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("en")) return "EN";
  if (raw.startsWith("ru")) return "RU";
  if (raw.startsWith("de")) return "DE";
  if (raw.startsWith("fr")) return "FR";
  if (raw.startsWith("es")) return "ES";
  if (raw.startsWith("it")) return "IT";
  if (raw.startsWith("pt")) return "PT";
  if (raw.startsWith("pl")) return "PL";
  if (raw.startsWith("uk")) return "UK";
  if (raw.startsWith("ja")) return "JA";
  if (raw.startsWith("ko")) return "KO";
  if (raw.startsWith("zh")) return "ZH";
  if (raw.startsWith("ar")) return "AR";
  if (raw.startsWith("tr")) return "TR";
  if (raw.startsWith("nl")) return "NL";
  return raw.toUpperCase().slice(0, 3);
}

function getVoiceGenderLabel(voice: VoiceRow): string | null {
  const raw = (voice.labels?.gender ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "male") return "Мужской";
  if (raw === "female") return "Женский";
  if (raw === "neutral") return "Нейтральный";
  return null;
}

const TONE_TAG_ALLOWLIST: Array<{ key: string; label: string; style?: VoiceStyleFilter }> = [
  { key: "warm", label: "Тёплый", style: "soft" },
  { key: "calm", label: "Спокойный", style: "soft" },
  { key: "soft", label: "Мягкий", style: "soft" },
  { key: "neutral", label: "Нейтральный", style: "neutral" },
  { key: "confident", label: "Уверенный", style: "confident" },
  { key: "professional", label: "Профессиональный", style: "premium" },
  { key: "clear", label: "Чёткий", style: "neutral" },
  { key: "energetic", label: "Энергичный", style: "energetic" },
  { key: "premium", label: "Премиальный", style: "premium" }
];

const NON_ENTERPRISE_TOKENS = new Set([
  "trickster",
  "seductive",
  "villain",
  "witch",
  "pirate",
  "character",
  "monster",
  "demon",
  "evil",
  "villainous",
  "sass",
  "sassy",
  "anime",
  "cartoon",
  "joker",
  "clown"
]);

function tokenizeVoiceText(voice: VoiceRow): string[] {
  const pieces: string[] = [];
  pieces.push(voice.name ?? "");
  for (const val of Object.values(voice.labels ?? {})) {
    if (typeof val === "string") pieces.push(val);
  }
  return pieces
    .join(" ")
    .toLowerCase()
    .replace(/[^a-zа-я0-9\s_-]+/g, " ")
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

function getVoiceToneTags(voice: VoiceRow): { tags: string[]; styles: Set<VoiceStyleFilter> } {
  const tokens = tokenizeVoiceText(voice);
  const tokenSet = new Set(tokens);
  for (const bad of NON_ENTERPRISE_TOKENS) {
    if (tokenSet.has(bad)) {
      // If the voice is explicitly character-ish, do not try to infer tone tags from it.
      return { tags: [], styles: new Set(["any"]) };
    }
  }

  const tags: string[] = [];
  const styles = new Set<VoiceStyleFilter>();
  for (const entry of TONE_TAG_ALLOWLIST) {
    if (tokenSet.has(entry.key)) {
      tags.push(entry.label);
      if (entry.style) styles.add(entry.style);
    }
  }

  // Heuristics: map a few common adjectives to enterprise tags.
  if (tokenSet.has("warm") || tokenSet.has("friendly")) tags.push("Тёплый");
  if (tokenSet.has("calm") || tokenSet.has("gentle")) tags.push("Спокойный");
  if (tokenSet.has("deep") && !tags.includes("Спокойный")) tags.push("Глубокий");
  if (tokenSet.has("clear")) tags.push("Чёткий");
  if (tokenSet.has("professional")) tags.push("Профессиональный");
  if (tokenSet.has("confident")) tags.push("Уверенный");

  // Dedupe + cap.
  const uniq = Array.from(new Set(tags)).slice(0, 4);
  return { tags: uniq, styles };
}

function matchesSearch(voice: VoiceRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const display = getVoiceDisplayName(voice).toLowerCase();
  const lang = (getVoiceLanguageLabel(voice) ?? "").toLowerCase();
  const gender = (getVoiceGenderLabel(voice) ?? "").toLowerCase();
  const tones = getVoiceToneTags(voice).tags.join(" ").toLowerCase();
  const rawName = (voice.name ?? "").toLowerCase();
  return (
    display.includes(q) ||
    rawName.includes(q) ||
    tones.includes(q) ||
    lang.includes(q) ||
    gender.includes(q)
  );
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

export function HrElevenLabsVoicePicker({ committedVoiceId, onSave, className }: Props) {
  const flagEnabled = process.env.NEXT_PUBLIC_ELEVENLABS_VOICE_OUTPUT === "1";
  const isProd = process.env.NODE_ENV === "production";
  const allowProd = process.env.NEXT_PUBLIC_ELEVENLABS_VOICE_OUTPUT_ALLOW_PROD === "1";
  const elevenLabsEnabled = flagEnabled && (!isProd || allowProd);
  const [editing, setEditing] = useState(false);
  const [draftVoiceId, setDraftVoiceId] = useState(committedVoiceId);
  const [search, setSearch] = useState("");
  const [filterLang, setFilterLang] = useState("any");
  const [filterGender, setFilterGender] = useState("any");
  const [filterStyle, setFilterStyle] = useState<VoiceStyleFilter>("any");
  const [voices, setVoices] = useState<VoiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type PreviewPhase = "idle" | "loading" | "playing";
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>("idle");
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewGenRef = useRef(0);
  const fetchSeqRef = useRef(0);
  const voicesCatalogAbortRef = useRef<AbortController | null>(null);
  const previewTtsAbortRef = useRef<AbortController | null>(null);
  const comboboxAnchorRef = useComboboxAnchor();

  const stopPreview = useCallback(() => {
    previewGenRef.current += 1;
    previewTtsAbortRef.current?.abort();
    previewTtsAbortRef.current = null;
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
      const ac = new AbortController();
      previewTtsAbortRef.current = ac;
      setPreviewPhase("loading");
      try {
        const res = await fetch("/api/tts/elevenlabs/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          signal: ac.signal,
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
      } catch (e) {
        if (isAbortError(e)) return;
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
      voicesCatalogAbortRef.current?.abort();
      stopPreview();
    };
  }, [stopPreview]);

  useEffect(() => {
    if (!editing) {
      setDraftVoiceId(committedVoiceId);
    }
  }, [committedVoiceId, editing]);

  const fetchVoices = useCallback(async () => {
    voicesCatalogAbortRef.current?.abort();
    const seq = ++fetchSeqRef.current;
    const ac = new AbortController();
    voicesCatalogAbortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      const q = search.trim();
      // Server-side filtering is useful for large catalogs, but it usually searches raw names only.
      // Keep it only for "long" queries; short queries should allow client-side matching against normalized tags.
      if (q.length >= 3) params.set("q", q);
      if (filterLang !== "any") params.set("lang", filterLang);
      if (filterGender !== "any") params.set("gender", filterGender);
      const qs = params.toString();
      const url = qs.length > 0 ? `/api/elevenlabs/voices?${qs}` : "/api/elevenlabs/voices";
      const res = await fetch(url, { signal: ac.signal });
      const data = (await res.json()) as { voices?: VoiceRow[]; error?: string };
      if (seq !== fetchSeqRef.current) return;
      if (!res.ok) {
        setError(data.error === "elevenlabs_not_configured" ? "no_api_key" : (data.error ?? "load_failed"));
        setVoices([]);
        return;
      }
      setVoices(Array.isArray(data.voices) ? data.voices : []);
    } catch (e) {
      if (seq !== fetchSeqRef.current) return;
      if (isAbortError(e)) return;
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
    voicesCatalogAbortRef.current?.abort();
    setSearch("");
    setFilterLang("any");
    setFilterGender("any");
    setFilterStyle("any");
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
    const base = Array.from(byId.values());
    const filtered = base
      .filter((v) => matchesSearch(v, search))
      .filter((v) => {
        if (filterStyle === "any") return true;
        const { styles, tags } = getVoiceToneTags(v);
        if (styles.has(filterStyle)) return true;
        // Fallback mapping for a couple of tags that don't encode explicit style bucket.
        if (filterStyle === "premium" && tags.includes("Профессиональный")) return true;
        if (filterStyle === "confident" && tags.includes("Уверенный")) return true;
        if (filterStyle === "soft" && (tags.includes("Тёплый") || tags.includes("Спокойный") || tags.includes("Мягкий"))) return true;
        if (filterStyle === "neutral" && (tags.includes("Нейтральный") || tags.includes("Чёткий"))) return true;
        if (filterStyle === "energetic" && tags.includes("Энергичный")) return true;
        return false;
      });

    const recommendedKeys = new Set(["Нейтральный", "Уверенный", "Тёплый", "Спокойный", "Профессиональный", "Чёткий"]);
    const isRecommended = (v: VoiceRow) => getVoiceToneTags(v).tags.some((t) => recommendedKeys.has(t));

    return filtered.sort((a, b) => {
      const ar = isRecommended(a) ? 0 : 1;
      const br = isRecommended(b) ? 0 : 1;
      if (ar !== br) return ar - br;
      return getVoiceDisplayName(a).localeCompare(getVoiceDisplayName(b), "ru");
    });
  }, [voices, draftVoiceId, committedVoiceId, filterStyle, search]);

  const committedLabel = useMemo(() => {
    const id = committedVoiceId.trim();
    if (!id) return "";
    const hit = voices.find((v) => v.voiceId === id);
    if (hit) return getVoiceDisplayName(hit);
    return "Сохранённый голос";
  }, [voices, committedVoiceId]);

  const draftFriendly = useMemo(() => {
    const id = draftVoiceId.trim();
    if (!id) return null;
    const row = selectRows.find((v) => v.voiceId === id);
    return row ? getVoiceDisplayName(row) : null;
  }, [selectRows, draftVoiceId]);

  const draftMeta = useMemo(() => {
    const id = draftVoiceId.trim();
    if (!id) return null;
    const row = selectRows.find((v) => v.voiceId === id) ?? voices.find((v) => v.voiceId === id) ?? null;
    if (!row) return null;
    const { tags } = getVoiceToneTags(row);
    const lang = getVoiceLanguageLabel(row);
    const gender = getVoiceGenderLabel(row);
    const secondary = [tags.join(" · "), gender, lang].filter((x) => typeof x === "string" && x.trim()).join(" · ");
    return { display: getVoiceDisplayName(row), secondary };
  }, [draftVoiceId, selectRows, voices]);

  const committedMeta = useMemo(() => {
    const id = committedVoiceId.trim();
    if (!id) return null;
    const row = voices.find((v) => v.voiceId === id) ?? null;
    if (!row) return null;
    const { tags } = getVoiceToneTags(row);
    const lang = getVoiceLanguageLabel(row);
    const gender = getVoiceGenderLabel(row);
    const secondary = [tags.join(" · "), gender, lang].filter((x) => typeof x === "string" && x.trim()).join(" · ");
    return { display: getVoiceDisplayName(row), secondary };
  }, [committedVoiceId, voices]);

  return (
    <TooltipProvider delay={400}>
      <div className={cn("flex min-w-0 flex-col gap-2 rounded-xl border border-slate-200/70 bg-white/50 p-2 text-xs text-slate-600 shadow-sm", className)}>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 gap-2">
            <Tooltip>
              <TooltipTrigger
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-sky-500 to-sky-600 text-white shadow-sm shadow-sky-500/20"
                aria-label="Подсказка по выбору голоса"
              >
                <Mic2 className="size-3.5" strokeWidth={2} aria-hidden />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px] text-xs leading-snug">
                Введите запрос в поле ниже или откройте список стрелкой, сузьте язык и пол при необходимости, прослушайте демо и сохраните.
              </TooltipContent>
            </Tooltip>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-semibold tracking-tight text-slate-800">Голос ассистента</span>
                {!elevenLabsEnabled ? (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-semibold">
                    Отключено
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-semibold">
                    DEV only
                  </Badge>
                )}
              </div>
              {!editing ? (
                <div className="mt-0.5 space-y-0.5">
                  <p className="text-[10px] font-medium text-slate-500">Сохранённый  </p>
                  {committedVoiceId.trim() ? (
                    <>
                      <p className="line-clamp-1 text-[12px] font-semibold leading-tight text-slate-800" title={committedMeta?.display ?? committedLabel}>
                        {committedMeta?.display ?? committedLabel}
                      </p>
                      {committedMeta?.secondary ? (
                        <p className="line-clamp-1 text-[10px] leading-tight text-slate-500" title={committedMeta.secondary}>
                          {committedMeta.secondary}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <p className="line-clamp-1 text-[12px] font-semibold leading-tight text-slate-800">Голос не выбран</p>
                      <p className="line-clamp-1 text-[10px] leading-tight text-slate-500">
                        Выберите голос для озвучки HR-ассистента.
                      </p>
                    </>
                  )}
                  {!elevenLabsEnabled ? (
                    <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-slate-500">
                      Сохранённый голос не применяется в текущем режиме. Сейчас используется голос OpenAI Realtime.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-0.5 line-clamp-1 text-[10px] leading-tight text-slate-500">
                  Поиск в одном поле → демо → «Сохранить».
                </p>
              )}
            </div>
          </div>
          {!editing ? (
            <div className="flex w-full shrink-0 gap-1.5 sm:ml-auto sm:w-auto">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 min-h-9 flex-1 gap-1.5 rounded-lg px-2.5 text-[11px] text-slate-700 hover:bg-white/50 sm:flex-initial"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3.5 shrink-0" aria-hidden />
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
                  voicesCatalogAbortRef.current?.abort();
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
                  toast.success("Голос сохранён", { description: "Следующие ответы ассистента будут с новым тембром." });
                  setEditing(false);
                  resetFiltersAndSearch();
                }}
              >
                Сохранить
              </Button>
            </div>
          )}
        </div>

        {!editing ? null : (
          <div className="space-y-2">
            <div className="flex gap-1.5">
              <div ref={comboboxAnchorRef} className="min-w-0 flex-1">
                <Combobox
                  value={draftVoiceId.trim() || null}
                  onValueChange={(v) => {
                    if (typeof v === "string" && v.length > 0) {
                      setDraftVoiceId(v);
                    }
                  }}
                  inputValue={search}
                  onInputValueChange={(v) => setSearch(v)}
                  filter={null}
                  autoComplete="none"
                >
                  <ComboboxInput
                    className="w-full min-w-0"
                    placeholder="Поиск: имя, стиль, язык"
                    disabled={error === "no_api_key" || error === "elevenlabs_not_configured"}
                    showClear
                  />
                  <ComboboxContent
                    anchor={comboboxAnchorRef}
                    side="bottom"
                    align="start"
                    sideOffset={4}
                    className="max-h-60 min-w-(--anchor-width) rounded-lg text-xs"
                  >
                    <ComboboxList className="max-h-52 space-y-0.5 p-1">
                      {selectRows.map((v, idx) => {
                        const display = getVoiceDisplayName(v);
                        const { tags } = getVoiceToneTags(v);
                        const lang = getVoiceLanguageLabel(v);
                        const gender = getVoiceGenderLabel(v);
                        const secondary = [tags.join(" · "), gender, lang].filter((x) => typeof x === "string" && x.trim()).join(" · ");
                        const recommendedKeys = new Set(["Нейтральный", "Уверенный", "Тёплый", "Спокойный", "Профессиональный", "Чёткий"]);
                        const isRecommended = tags.some((t) => recommendedKeys.has(t));
                        const prev = selectRows[idx - 1];
                        const prevIsRecommended = prev ? getVoiceToneTags(prev).tags.some((t) => recommendedKeys.has(t)) : null;
                        const showRecommendedHeader = idx === 0 && isRecommended;
                        const showOthersHeader = idx > 0 && prevIsRecommended === true && !isRecommended;

                        return (
                          <div key={v.voiceId}>
                            {showRecommendedHeader ? (
                              <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                                Рекомендовано для интервью
                              </p>
                            ) : null}
                            {showOthersHeader ? (
                              <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                                Все голоса
                              </p>
                            ) : null}
                            <ComboboxItem value={v.voiceId} className="rounded-md py-1.5 pr-8 pl-2 text-xs">
                              <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="flex min-w-0 items-center gap-2">
                                  <span className="truncate text-[12px] font-semibold text-slate-800">{display}</span>
                                  {isRecommended ? (
                                    <Badge variant="secondary" className="h-4 rounded-full px-1.5 text-[9px] font-normal text-slate-600">
                                      Рек.
                                    </Badge>
                                  ) : null}
                                </span>
                                {secondary ? (
                                  <span className="truncate text-[10px] leading-tight text-slate-500">{secondary}</span>
                                ) : null}
                              </span>
                            </ComboboxItem>
                          </div>
                        );
                      })}
                    </ComboboxList>
                    <ComboboxEmpty className="px-3 py-3 text-center text-[11px] text-muted-foreground">
                      {loading ? (
                        "Загрузка…"
                      ) : (
                        <div className="space-y-2">
                          <div>
                            <p className="text-[12px] font-medium text-slate-700">Голоса не найдены</p>
                            <p className="mt-0.5 text-[11px] text-slate-500">Попробуйте изменить язык, пол или стиль.</p>
                          </div>
                          <Button type="button" variant="outline" size="sm" className="h-8 rounded-md px-2 text-[11px]" onClick={resetFiltersAndSearch}>
                            Сбросить фильтры
                          </Button>
                        </div>
                      )}
                    </ComboboxEmpty>
                  </ComboboxContent>
                </Combobox>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-9 shrink-0 rounded-lg"
                title="Обновить каталог"
                disabled={loading}
                onClick={() => void fetchVoices()}
              >
                <RotateCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
              </Button>
            </div>

            {draftVoiceId.trim() ? (
              <div className="rounded-lg border border-slate-200/70 bg-white/70 px-2.5 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Выбрано</p>
                <p className="mt-0.5 truncate text-xs font-semibold text-slate-800" title={draftMeta?.display ?? draftFriendly ?? undefined}>
                  {draftMeta?.display ?? draftFriendly ?? "—"}
                </p>
                {draftMeta?.secondary ? (
                  <p className="mt-0.5 truncate text-[10px] leading-tight text-slate-500">{draftMeta.secondary}</p>
                ) : null}
              </div>
            ) : (
              <div className="rounded-lg border border-slate-200/70 bg-white/70 px-2.5 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Выбрано</p>
                <p className="mt-0.5 text-xs font-semibold text-slate-700">Голос не выбран</p>
              </div>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-3 gap-2">
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
                <div className="grid min-w-0 gap-1">
                  <Label htmlFor="hr-el-style" className="text-[10px] font-medium text-slate-500">
                    Стиль
                  </Label>
                  <NativeSelect
                    id="hr-el-style"
                    size="sm"
                    className="w-full min-w-0"
                    value={filterStyle}
                    onChange={(e) => setFilterStyle(e.target.value as VoiceStyleFilter)}
                  >
                    {STYLE_OPTIONS.map((opt) => (
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
                  Загрузка каталога…
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

            <Collapsible className="rounded-lg border border-slate-200/70 bg-slate-50/40 px-2 py-1.5">
              <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left text-[10px] font-medium text-slate-600 hover:text-slate-800 data-panel-open:[&>svg]:rotate-180">
                <span>Для поддержки (технический id)</span>
                <ChevronDown className="size-3.5 shrink-0 transition-transform" aria-hidden />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2 data-ending-style:hidden">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 break-all font-mono text-[10px] leading-snug text-slate-700">
                    {draftVoiceId.trim() || "—"}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-8 shrink-0"
                    title="Скопировать id"
                    disabled={!draftVoiceId.trim()}
                    onClick={() => {
                      const t = draftVoiceId.trim();
                      if (!t) return;
                      void navigator.clipboard.writeText(t);
                      toast.success("Скопировано");
                    }}
                  >
                    <Copy className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </CollapsibleContent>
            </Collapsible>

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
