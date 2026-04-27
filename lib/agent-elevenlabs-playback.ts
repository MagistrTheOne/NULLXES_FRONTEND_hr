"use client";

let currentAgentTtsAudio: HTMLAudioElement | null = null;

export function stopAgentElevenLabsPlayback(): void {
  if (!currentAgentTtsAudio) {
    return;
  }
  try {
    currentAgentTtsAudio.pause();
  } catch {
    /* noop */
  }
  const src = currentAgentTtsAudio.src;
  if (src.startsWith("blob:")) {
    URL.revokeObjectURL(src);
  }
  currentAgentTtsAudio.removeAttribute("src");
  currentAgentTtsAudio.load();
  currentAgentTtsAudio = null;
}

/**
 * Plays one agent utterance via our streaming TTS proxy (full response buffered
 * to blob — keeps implementation small; swap to MSE later if needed).
 */
export async function playAgentUtteranceWithElevenLabs(
  text: string,
  voiceId: string,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed.length) {
    return;
  }
  if (!voiceId.trim()) {
    console.warn("[elevenlabs-agent-tts] missing voiceId");
    return;
  }

  stopAgentElevenLabsPlayback();

  const res = await fetch("/api/tts/elevenlabs/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ text: trimmed.slice(0, 8000), voiceId: voiceId.trim() }),
    signal: options?.signal
  });

  if (!res.ok) {
    console.warn("[elevenlabs-agent-tts] stream failed", res.status);
    return;
  }

  const blob = await res.blob();
  options?.signal?.throwIfAborted();

  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  currentAgentTtsAudio = audio;
  audio.src = url;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (currentAgentTtsAudio === audio) {
        currentAgentTtsAudio = null;
      }
    };
    audio.onended = () => {
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("elevenlabs_audio_element_error"));
    };
    void audio.play().catch((err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
