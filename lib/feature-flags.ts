export function isElevenLabsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ELEVENLABS_VOICE_OUTPUT_ALLOW_PROD === "1";
}

export function isRecordingUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_STREAM_RECORDING_UI === "1";
}

