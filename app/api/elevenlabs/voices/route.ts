import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { NextResponse, type NextRequest } from "next/server";

export type ElevenLabsVoiceListItem = {
  voiceId: string;
  name: string;
  previewUrl?: string;
};

/**
 * Lists voices from the configured ElevenLabs account (API key server-side only).
 * Optional `q` uses the search API; otherwise returns getAll (capped).
 */
export async function GET(req: NextRequest) {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "elevenlabs_not_configured", voices: [] as ElevenLabsVoiceListItem[] },
      { status: 503 }
    );
  }

  const q = req.nextUrl.searchParams.get("q")?.trim();
  const client = new ElevenLabsClient({ apiKey });

  const mapVoice = (v: { voiceId: string; name?: string; previewUrl?: string }): ElevenLabsVoiceListItem => ({
    voiceId: v.voiceId,
    name: (v.name && v.name.length > 0 ? v.name : v.voiceId) as string,
    previewUrl: v.previewUrl
  });

  try {
    if (q && q.length > 0) {
      const res = await client.voices.search({ search: q, pageSize: 50 });
      const voices = (res.voices ?? []).map(mapVoice);
      return NextResponse.json({ voices }, { status: 200 });
    }

    const res = await client.voices.getAll({ showLegacy: true });
    const voices = (res.voices ?? []).slice(0, 400).map(mapVoice);
    return NextResponse.json({ voices }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "voices_failed";
    return NextResponse.json({ error: "elevenlabs_error", message, voices: [] }, { status: 502 });
  }
}
