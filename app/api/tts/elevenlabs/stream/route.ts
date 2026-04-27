import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { resolveElevenLabsVoiceId, type MiraVoicePresetId } from "@/lib/interview-voice-presets";

const bodySchema = z.object({
  text: z.string().min(1).max(8000),
  /** Direct ElevenLabs `voice_id` from /api/elevenlabs/voices or the dashboard. */
  voiceId: z.string().min(8).max(128).optional(),
  voiceKey: z.enum(["mira_core", "mira_soft", "mira_strict"]).optional()
});

/**
 * Proxies ElevenLabs streaming TTS (model eleven_flash_v2_5) so the API key
 * stays server-side. Client sends text + optional voice preset; audio/mpeg streams back.
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

  const trimmedVoiceId = parsed.data.voiceId?.trim();
  const voiceId: string = trimmedVoiceId?.length
    ? trimmedVoiceId
    : resolveElevenLabsVoiceId((parsed.data.voiceKey ?? "mira_core") as MiraVoicePresetId);

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
