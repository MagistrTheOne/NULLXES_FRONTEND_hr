import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

const bodySchema = z.object({
  text: z.string().min(1).max(8000),
  /** ElevenLabs voice id from Voice Library / dashboard (e.g. JBFqnCBsd6RMkjVDRZzb). */
  voiceId: z.string().min(8).max(128).optional()
});

function resolveVoiceId(requestVoiceId: string | undefined): string | null {
  const fromBody = requestVoiceId?.trim();
  if (fromBody && /^[a-zA-Z0-9_-]+$/.test(fromBody)) {
    return fromBody;
  }
  const fromEnv = process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim();
  if (fromEnv && /^[a-zA-Z0-9_-]+$/.test(fromEnv)) {
    return fromEnv;
  }
  return null;
}

/**
 * Proxies ElevenLabs streaming TTS (model eleven_flash_v2_5). Client sends `voiceId`
 * (real ElevenLabs id); optional server fallback `ELEVENLABS_DEFAULT_VOICE_ID`.
 */
export async function POST(req: NextRequest) {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "elevenlabs_not_configured" }, { status: 503 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const voiceId = resolveVoiceId(parsed.data.voiceId);
  if (!voiceId) {
    return NextResponse.json(
      { error: "voice_id_required", message: "Pass voiceId or set ELEVENLABS_DEFAULT_VOICE_ID on the server." },
      { status: 400 }
    );
  }

  const client = new ElevenLabsClient({ apiKey });

  try {
    const audioStream = await client.textToSpeech.stream(voiceId, {
      modelId: "eleven_flash_v2_5",
      text: parsed.data.text,
      outputFormat: "mp3_22050_32",
      optimizeStreamingLatency: 3
    });

    return new NextResponse(audioStream, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store"
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "tts_failed";
    return NextResponse.json({ error: "elevenlabs_error", message }, { status: 502 });
  }
}
