export function isRecordingUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_STREAM_RECORDING_UI === "1";
}

