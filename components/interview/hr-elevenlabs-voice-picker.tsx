"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
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

type VoiceRow = { voiceId: string; name: string };

type Props = {
  committedVoiceId: string;
  onSave: (voiceId: string) => void;
  className?: string;
};

export function HrElevenLabsVoicePicker({ committedVoiceId, onSave, className }: Props) {
  const [editing, setEditing] = useState(false);
  const [draftVoiceId, setDraftVoiceId] = useState(committedVoiceId);
  const [search, setSearch] = useState("");
  const [voices, setVoices] = useState<VoiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraftVoiceId(committedVoiceId);
    }
  }, [committedVoiceId, editing]);

  const loadVoices = useCallback(async (q?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url =
        q && q.trim().length > 0
          ? `/api/elevenlabs/voices?q=${encodeURIComponent(q.trim())}`
          : "/api/elevenlabs/voices";
      const res = await fetch(url);
      const data = (await res.json()) as { voices?: VoiceRow[]; error?: string };
      if (!res.ok) {
        setError(data.error === "elevenlabs_not_configured" ? "no_api_key" : (data.error ?? "load_failed"));
        setVoices([]);
        return;
      }
      setVoices(Array.isArray(data.voices) ? data.voices : []);
    } catch {
      setError("network");
      setVoices([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!editing) {
      return;
    }
    const q = search.trim();
    const delayMs = q.length > 0 ? 320 : 0;
    const t = window.setTimeout(() => {
      void loadVoices(q.length > 0 ? q : undefined);
    }, delayMs);
    return () => window.clearTimeout(t);
  }, [editing, search, loadVoices]);

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

  const elevenOutOn = process.env.NEXT_PUBLIC_ELEVENLABS_VOICE_OUTPUT === "1";

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border border-slate-300/50 bg-white/60 p-3 text-xs text-slate-600",
        className
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 font-medium text-slate-700">Голос ElevenLabs</span>
        {!editing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10 min-h-10 shrink-0 px-3 text-[11px] sm:h-8 sm:min-h-8"
            onClick={() => setEditing(true)}
          >
            Изменить
          </Button>
        ) : (
          <div className="flex shrink-0 gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-10 min-h-10 px-3 text-[11px] sm:h-8 sm:min-h-8"
              onClick={() => {
                setEditing(false);
                setDraftVoiceId(committedVoiceId);
                setSearch("");
              }}
            >
              Отмена
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-10 min-h-10 px-3 text-[11px] sm:h-8 sm:min-h-8"
              disabled={!draftVoiceId.trim()}
              onClick={() => {
                const next = draftVoiceId.trim();
                if (!next) return;
                onSave(next);
                setEditing(false);
                setSearch("");
              }}
            >
              Сохранить
            </Button>
          </div>
        )}
      </div>

      {!elevenOutOn ? (
        <p className="text-[11px] leading-snug text-amber-900">
          Для озвучки через ElevenLabs в сборке нужны{" "}
          <span className="font-mono">NEXT_PUBLIC_ELEVENLABS_VOICE_OUTPUT=1</span> и на сервере{" "}
          <span className="font-mono">ELEVENLABS_API_KEY</span>.
        </p>
      ) : null}

      {!editing ? (
        <p className="truncate font-mono text-[11px] text-slate-700" title={committedVoiceId}>
          {committedLabel}
        </p>
      ) : (
        <div className="space-y-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по каталогу ElevenLabs…"
            className="h-10 min-h-10 text-xs sm:h-8 sm:min-h-8"
          />
          {loading ? (
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Загрузка голосов…
            </div>
          ) : null}
          {error === "no_api_key" || error === "elevenlabs_not_configured" ? (
            <p className="text-[11px] text-rose-700">На сервере не задан ELEVENLABS_API_KEY — список голосов недоступен.</p>
          ) : error ? (
            <p className="text-[11px] text-rose-700">Не удалось загрузить голоса ({error}).</p>
          ) : null}
          <Select
            value={draftVoiceId.trim() || undefined}
            onValueChange={(v) => {
              if (typeof v === "string" && v.length > 0) {
                setDraftVoiceId(v);
              }
            }}
          >
            <SelectTrigger size="sm" className="h-11 min-h-11 w-full min-w-0 font-mono text-[11px] sm:h-9 sm:min-h-9">
              <SelectValue placeholder="Выберите voice_id" />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {selectRows.length === 0 && !loading && !error ? (
                <p className="px-2 py-2 text-[11px] text-slate-500">Голоса не найдены.</p>
              ) : (
                selectRows.map((v) => (
                  <SelectItem
                    key={v.voiceId}
                    value={v.voiceId}
                    className="items-start py-2 text-left text-[11px]"
                    title={`${v.name} — ${v.voiceId}`}
                  >
                    <span className="block font-medium text-slate-800">{v.name}</span>
                    <span className="mt-0.5 block font-mono text-[10px] leading-tight text-slate-500">{v.voiceId}</span>
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
