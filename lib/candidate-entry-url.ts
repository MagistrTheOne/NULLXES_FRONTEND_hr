/** Достаёт `jobAiId` из полного URL, относительного пути или произвольной строки с `?jobAiId=` / `&jobAiId=`. */
export function extractJobAiIdFromEntryUrl(input: string): number | null {
  const value = input.trim();
  if (!value) {
    return null;
  }

  const fromPlain = value.match(/[?&]jobAiId=(\d+)/i);
  if (fromPlain) {
    const parsed = Number(fromPlain[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  try {
    const url = new URL(value, "http://localhost");
    const raw = url.searchParams.get("jobAiId");
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** True if pasted URL or path includes `entry=candidate` (for HR paste → same candidate mode). */
export function extractEntryCandidateFromPastedUrl(input: string): boolean {
  const value = input.trim();
  if (!value) {
    return false;
  }
  if (/(?:[?&])entry=candidate(?:&|$)/i.test(value)) {
    return true;
  }
  try {
    const url = new URL(value, "http://localhost");
    return url.searchParams.get("entry") === "candidate";
  } catch {
    return false;
  }
}

function isBlankEntryPath(value: string): boolean {
  const v = value.trim();
  return !v || v === "undefined" || v === "null";
}

/**
 * Базовый путь/URL для ссылки кандидата в Nullxes JobAI (HR UI).
 * Gateway иногда кладёт в `candidateLink` внешние заглушки (Zoom и т.п.) без `jobAiId` —
 * такие URL здесь отбрасываем и строим `/?jobAiId=…`, иначе `extractJobAiIdFromEntryUrl` падает.
 */
export function resolveHrCandidateEntryBasePath(
  candidateEntryPath: string | null | undefined,
  jobAiId: number
): string {
  const idOk = Number.isInteger(jobAiId) && jobAiId > 0;
  const raw = typeof candidateEntryPath === "string" ? candidateEntryPath.trim() : "";
  if (isBlankEntryPath(raw)) {
    return idOk ? `/?jobAiId=${encodeURIComponent(String(jobAiId))}` : "/";
  }

  if (/^https?:\/\//i.test(raw)) {
    if (/[?&]jobAiId=\d+/i.test(raw)) {
      return raw;
    }
    return idOk ? `/?jobAiId=${encodeURIComponent(String(jobAiId))}` : "/";
  }

  if (raw.startsWith("/")) {
    return raw;
  }
  if (raw.startsWith("?")) {
    return `/${raw}`;
  }
  return `/${raw}`;
}

/** Appends `entry=candidate` so the home page can run candidate-only auto-flow without affecting HR. */
export function withCandidateEntryQuery(pathOrUrl: string): string {
  const trimmed = pathOrUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.includes("entry=candidate")) {
    return trimmed;
  }
  const joiner = trimmed.includes("?") ? "&" : "?";
  return `${trimmed}${joiner}entry=candidate`;
}
