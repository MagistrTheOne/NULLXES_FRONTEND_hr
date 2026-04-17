"use client";

export type ObserverVisibility = "hidden" | "visible";
export type ObserverTalk = "off" | "on";

export type ObserverControlState = {
  visibility: ObserverVisibility;
  talk: ObserverTalk;
  updatedAt: string;
};

const DEFAULT_STATE: ObserverControlState = {
  visibility: "hidden",
  talk: "off",
  updatedAt: ""
};

const OBSERVER_CONTROL_EVENT = "nullxes:observer-control:changed";
const CURRENT_NAMESPACE = "nullxes:observer-control";
const LEGACY_NAMESPACE = "jobaidemo:observer-control";

function normalizeObserverControlState(next: Partial<ObserverControlState>): ObserverControlState {
  const visibility: ObserverVisibility = next.visibility === "visible" ? "visible" : "hidden";
  const talk: ObserverTalk = visibility === "hidden" ? "off" : next.talk === "on" ? "on" : "off";
  return {
    visibility,
    talk,
    updatedAt: typeof next.updatedAt === "string" && next.updatedAt ? next.updatedAt : new Date().toISOString()
  };
}

function storageKey(jobAiId: number | null): string | null {
  return jobAiId && jobAiId > 0 ? `${CURRENT_NAMESPACE}:${jobAiId}` : null;
}

function legacyStorageKey(jobAiId: number | null): string | null {
  return jobAiId && jobAiId > 0 ? `${LEGACY_NAMESPACE}:${jobAiId}` : null;
}

export function getObserverControlState(jobAiId: number | null): ObserverControlState {
  if (typeof window === "undefined") {
    return DEFAULT_STATE;
  }
  const key = storageKey(jobAiId);
  if (!key) {
    return DEFAULT_STATE;
  }
  const raw = window.localStorage.getItem(key);
  const legacyKey = legacyStorageKey(jobAiId);
  const fallback = !raw && legacyKey ? window.localStorage.getItem(legacyKey) : null;
  const source = raw ?? fallback;
  if (!source) {
    return DEFAULT_STATE;
  }
  try {
    const parsed = JSON.parse(source) as Partial<ObserverControlState>;
    const normalized = normalizeObserverControlState(parsed);
    if (!raw && fallback && key) {
      window.localStorage.setItem(key, JSON.stringify(normalized));
    }
    return normalized;
  } catch {
    return DEFAULT_STATE;
  }
}

export function resolveObserverVisibilityState(
  current: ObserverControlState,
  nextVisible: boolean
): ObserverControlState {
  return normalizeObserverControlState({
    visibility: nextVisible ? "visible" : "hidden",
    talk: nextVisible ? current.talk : "off"
  });
}

export function resolveObserverTalkState(
  current: ObserverControlState,
  nextTalk: ObserverTalk
): ObserverControlState {
  return normalizeObserverControlState({
    visibility: current.visibility,
    talk: current.visibility === "visible" ? nextTalk : "off"
  });
}

export function setObserverControlState(jobAiId: number | null, next: ObserverControlState): void {
  if (typeof window === "undefined") {
    return;
  }
  const key = storageKey(jobAiId);
  if (!key) {
    return;
  }
  const normalized = normalizeObserverControlState(next);
  window.localStorage.setItem(key, JSON.stringify(normalized));
  window.dispatchEvent(
    new CustomEvent(OBSERVER_CONTROL_EVENT, {
      detail: {
        jobAiId,
        state: normalized
      }
    })
  );
}

export function subscribeObserverControlState(
  jobAiId: number | null,
  onChange: (next: ObserverControlState) => void
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const onStorage = (event: StorageEvent) => {
    const key = storageKey(jobAiId);
    if (!key || event.key !== key) {
      return;
    }
    onChange(getObserverControlState(jobAiId));
  };

  const onCustom = (event: Event) => {
    const customEvent = event as CustomEvent<{ jobAiId: number | null }>;
    if (customEvent.detail?.jobAiId !== jobAiId) {
      return;
    }
    onChange(getObserverControlState(jobAiId));
  };

  window.addEventListener("storage", onStorage);
  window.addEventListener(OBSERVER_CONTROL_EVENT, onCustom as EventListener);

  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(OBSERVER_CONTROL_EVENT, onCustom as EventListener);
  };
}
