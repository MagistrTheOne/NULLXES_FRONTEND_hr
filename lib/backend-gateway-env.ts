/**
 * Единая база URL realtime-gateway для server-side вызовов.
 * В production / на Vercel без BACKEND_GATEWAY_URL — явный отказ (не localhost).
 */

function isProductionLike(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

/** Нормализованный base URL или null, если в prod-like окружении переменная не задана. */
export function resolveBackendGatewayBaseUrl(): string | null {
  const raw = process.env.BACKEND_GATEWAY_URL?.trim();
  if (raw) {
    return raw.replace(/\/+$/, "");
  }
  if (isProductionLike()) {
    return null;
  }
  return "http://localhost:8080";
}

export function getBackendGatewayBaseUrl(): string {
  const resolved = resolveBackendGatewayBaseUrl();
  if (!resolved) {
    throw new Error("BACKEND_GATEWAY_URL is required when NODE_ENV=production or VERCEL=1");
  }
  return resolved;
}
