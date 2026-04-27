import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { NextResponse, type NextRequest } from "next/server";

export type ElevenLabsVoiceListItem = {
  voiceId: string;
  name: string;
  previewUrl?: string;
  /** ElevenLabs voice labels (gender, accent, language, …) — для UI-чипов. */
  labels?: Record<string, string>;
};

/** Ключи ISO → слова, по которым ищет каталог ElevenLabs (поле search). */
const LANG_KEYWORDS: Record<string, string> = {
  en: "english",
  ru: "russian",
  de: "german",
  fr: "french",
  es: "spanish",
  it: "italian",
  pt: "portuguese",
  pl: "polish",
  uk: "ukrainian",
  zh: "chinese",
  ja: "japanese",
  ko: "korean",
  hi: "hindi",
  ar: "arabic",
  tr: "turkish",
  nl: "dutch",
  sv: "swedish",
  no: "norwegian",
  da: "danish",
  fi: "finnish",
  cs: "czech",
  el: "greek",
  he: "hebrew",
  id: "indonesian",
  ms: "malay",
  th: "thai",
  vi: "vietnamese"
};

const ALLOWED_LANG = new Set(["any", ...Object.keys(LANG_KEYWORDS)]);
const ALLOWED_GENDER = new Set(["any", "female", "male", "neutral"]);

function normalizeLang(raw: string | null): string {
  const v = (raw ?? "any").trim().toLowerCase();
  return ALLOWED_LANG.has(v) ? v : "any";
}

function normalizeGender(raw: string | null): string {
  const v = (raw ?? "any").trim().toLowerCase();
  return ALLOWED_GENDER.has(v) ? v : "any";
}

/**
 * Собирает строку для voices.search: текст + язык + пол (API не даёт отдельных полей,
 * но ищет по name, description, labels, category).
 */
function buildCatalogSearchText(q: string, lang: string, gender: string): string {
  const parts: string[] = [];
  const trimmed = q.trim();
  if (trimmed.length > 0) {
    parts.push(trimmed);
  }
  if (lang !== "any") {
    parts.push(LANG_KEYWORDS[lang] ?? lang);
  }
  if (gender !== "any") {
    parts.push(gender);
  }
  return parts.join(" ").trim();
}

/**
 * Lists voices from the configured ElevenLabs account (API key server-side only).
 * Query: `q` — текст; `lang` — ISO или `any`; `gender` — `female` | `male` | `neutral` | `any`.
 * Если после сборки строка пуста — getAll (с лимитом).
 */
export async function GET(req: NextRequest) {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "elevenlabs_not_configured", voices: [] as ElevenLabsVoiceListItem[] },
      { status: 503 }
    );
  }

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const lang = normalizeLang(req.nextUrl.searchParams.get("lang"));
  const gender = normalizeGender(req.nextUrl.searchParams.get("gender"));
  const client = new ElevenLabsClient({ apiKey });

  const mapVoice = (v: {
    voiceId: string;
    name?: string;
    previewUrl?: string;
    labels?: Record<string, string>;
  }): ElevenLabsVoiceListItem => ({
    voiceId: v.voiceId,
    name: (v.name && v.name.length > 0 ? v.name : v.voiceId) as string,
    previewUrl: v.previewUrl,
    labels: v.labels && Object.keys(v.labels).length > 0 ? v.labels : undefined
  });

  const searchText = buildCatalogSearchText(q, lang, gender);

  try {
    if (searchText.length > 0) {
      const res = await client.voices.search({
        search: searchText,
        pageSize: 100,
        sort: "name",
        sortDirection: "asc"
      });
      const voices = (res.voices ?? []).map(mapVoice);
      return NextResponse.json({ voices, meta: { lang, gender, mode: "search" as const } }, { status: 200 });
    }

    const res = await client.voices.getAll({ showLegacy: true });
    const voices = (res.voices ?? []).slice(0, 400).map(mapVoice);
    return NextResponse.json({ voices, meta: { lang, gender, mode: "list" as const } }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "voices_failed";
    return NextResponse.json({ error: "elevenlabs_error", message, voices: [] }, { status: 502 });
  }
}
