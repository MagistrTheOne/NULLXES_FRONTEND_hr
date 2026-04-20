/**
 * Decodes the middle part of a JWT (base64url JSON payload) without validating
 * the signature. The HR dashboard only needs to READ `jobAiId` from a pasted
 * join-link so it can select the correct interview row — trust is re-verified
 * by the gateway when the candidate/spectator actually opens that link.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payloadB64 = parts[1] ?? "";
  if (!payloadB64) return null;
  // base64url → base64 (replace URL-safe chars, pad to multiple of 4).
  const base64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    const raw =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("binary");
    // Decode UTF-8 safely (JWT payloads may contain non-ASCII claim values).
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const json =
      typeof TextDecoder !== "undefined"
        ? new TextDecoder("utf-8").decode(bytes)
        : raw;
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** JWT regex: three base64url segments separated by dots. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** `/join/<role>/<JWT>` path in a URL or raw path string. */
const JOIN_PATH_JWT = /\/join\/(?:candidate|spectator)\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i;

function extractJobAiIdFromJwt(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const raw = payload.jobAiId;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * Достаёт `jobAiId` из:
 *   1) полного URL или относительного пути с `?jobAiId=` / `&jobAiId=` (legacy);
 *   2) пути `/join/<role>/<JWT>` — читает `jobAiId` из payload JWT;
 *   3) голого JWT-токена (`header.payload.sig`).
 * В (2) и (3) подпись не проверяется — это чисто UI-парсинг для выбора
 * нужной строки интервью; реальная валидация происходит на gateway.
 */
export function extractJobAiIdFromEntryUrl(input: string): number | null {
  const value = input.trim();
  if (!value) {
    return null;
  }

  const fromPlain = value.match(/[?&]jobAiId=(\d+)/i);
  if (fromPlain) {
    const parsed = Number(fromPlain[1]);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }

  // /join/<role>/<JWT> inside a full URL or a relative path.
  const joinMatch = value.match(JOIN_PATH_JWT);
  if (joinMatch && joinMatch[1]) {
    const fromJwt = extractJobAiIdFromJwt(joinMatch[1]);
    if (fromJwt) return fromJwt;
  }

  // Raw JWT pasted without any URL wrapper.
  if (JWT_SHAPE.test(value)) {
    const fromJwt = extractJobAiIdFromJwt(value);
    if (fromJwt) return fromJwt;
  }

  try {
    const url = new URL(value, "http://localhost");
    const raw = url.searchParams.get("jobAiId");
    if (raw) {
      const parsed = Number(raw);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    // Fallback: URL parsed, but the jobAiId lives only inside the /join JWT.
    const pathMatch = url.pathname.match(JOIN_PATH_JWT);
    if (pathMatch && pathMatch[1]) {
      const fromJwt = extractJobAiIdFromJwt(pathMatch[1]);
      if (fromJwt) return fromJwt;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True if pasted URL or path is a candidate-mode entry: either the legacy
 * `?entry=candidate` shape, or the new JWT route `/join/candidate/<JWT>`.
 * Spectator JWT (`/join/spectator/<JWT>`) is explicitly NOT treated as
 * candidate mode — HR keeps observer-style entry for those links.
 */
export function extractEntryCandidateFromPastedUrl(input: string): boolean {
  const value = input.trim();
  if (!value) {
    return false;
  }
  if (/(?:[?&])entry=candidate(?:&|$)/i.test(value)) {
    return true;
  }
  if (/\/join\/candidate\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(value)) {
    return true;
  }
  try {
    const url = new URL(value, "http://localhost");
    if (url.searchParams.get("entry") === "candidate") return true;
    return /^\/join\/candidate\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(
      url.pathname
    );
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
