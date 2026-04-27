/**
 * ElevenLabs voice presets for HR-selected TTS (see /api/tts/elevenlabs/stream).
 * Override defaults with env ELEVENLABS_VOICE_MIRA_CORE, etc. (server) or
 * NEXT_PUBLIC_ELEVENLABS_VOICE_* if read from client bundles.
 *
 * Prod default voice_id when no preset env is set: `NEXT_PUBLIC_ELEVENLABS_DEFAULT_VOICE_ID`
 * or the public “George” sample from ElevenLabs docs.
 */
export type MiraVoicePresetId = "mira_core" | "mira_soft" | "mira_strict";

/** localStorage key — HR stand picks a real `voice_id` before joining a session. */
export const HR_ELEVENLABS_VOICE_STORAGE_KEY = "nullxes:hr-elevenlabs-voice-id";

/** Public preset voice from ElevenLabs quickstart (“George”) — replace in prod via env. */
const DOCUMENTATION_DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

export function getDefaultElevenLabsVoiceId(): string {
  const v = process.env.NEXT_PUBLIC_ELEVENLABS_DEFAULT_VOICE_ID?.trim();
  return v && v.length > 0 ? v : DOCUMENTATION_DEFAULT_VOICE_ID;
}

export const MIRA_VOICE_PRESET_LABELS: Record<MiraVoicePresetId, string> = {
  mira_core: "Mira Core",
  mira_soft: "Mira Soft",
  mira_strict: "Mira Strict"
};

export const MIRA_VOICE_PRESET_ORDER: MiraVoicePresetId[] = ["mira_core", "mira_soft", "mira_strict"];

function envVoiceId(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/** Resolves ElevenLabs `voice_id` for API calls (server or client bundle). */
export function resolveElevenLabsVoiceId(preset: MiraVoicePresetId): string {
  const upper = preset.toUpperCase().replace(/-/g, "_");
  return (
    envVoiceId(`ELEVENLABS_VOICE_${upper}`) ??
    envVoiceId(`NEXT_PUBLIC_ELEVENLABS_VOICE_${upper}`) ??
    getDefaultElevenLabsVoiceId()
  );
}

export function isMiraVoicePresetId(value: string): value is MiraVoicePresetId {
  return value === "mira_core" || value === "mira_soft" || value === "mira_strict";
}
