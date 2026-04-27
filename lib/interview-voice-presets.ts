/**
 * ElevenLabs voice presets for HR-selected TTS (see /api/tts/elevenlabs/stream).
 * Override defaults with env ELEVENLABS_VOICE_MIRA_CORE, etc. (server) or
 * NEXT_PUBLIC_ELEVENLABS_VOICE_* if read from client bundles.
 */
export type MiraVoicePresetId = "mira_core" | "mira_soft" | "mira_strict";

const DEFAULT_VOICE_IDS: Record<MiraVoicePresetId, string> = {
  mira_core: "voice_id_1",
  mira_soft: "voice_id_2",
  mira_strict: "voice_id_3"
};

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
    DEFAULT_VOICE_IDS[preset]
  );
}

export function isMiraVoicePresetId(value: string): value is MiraVoicePresetId {
  return value === "mira_core" || value === "mira_soft" || value === "mira_strict";
}
