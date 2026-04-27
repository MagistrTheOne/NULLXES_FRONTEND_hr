import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { NextResponse } from "next/server";

const MAX_VOICES = 150;

/**
 * Lists ElevenLabs voices for the HR picker (voice_id + name). API key stays server-side.
 */
export async function GET() {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "elevenlabs_not_configured" }, { status: 503 });
  }

  try {
    const client = new ElevenLabsClient({ apiKey });
    const data = await client.voices.getAll({ showLegacy: true });
    const raw = data.voices ?? [];
    const voices = raw.slice(0, MAX_VOICES).map((v) => ({
      voiceId: v.voiceId,
      name: (v.name?.trim() || v.voiceId).slice(0, 80)
    }));
    return NextResponse.json({ voices }, { headers: { "Cache-Control": "private, max-age=120" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "voices_list_failed";
    return NextResponse.json({ error: "elevenlabs_error", message }, { status: 502 });
  }
}
