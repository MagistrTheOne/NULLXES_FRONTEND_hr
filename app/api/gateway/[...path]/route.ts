import { NextResponse, type NextRequest } from "next/server";

import { resolveBackendGatewayBaseUrl } from "@/lib/backend-gateway-env";

/** Разрешённые корни пути относительно realtime-gateway (см. lib/api.ts + spectator SSE). */
function isGatewayPathAllowed(segments: string[]): boolean {
  if (segments.length === 0) {
    return false;
  }
  const [a, b, c, d] = segments;
  if (a === "api" && b === "v1" && c === "questions" && d === "general" && segments.length === 4) {
    return true;
  }
  const roots = new Set(["realtime", "runtime", "meetings", "interviews", "join"]);
  return roots.has(a);
}

const SAFE_HEADER_NAMES = new Set(
  [
    "accept",
    "accept-encoding",
    "accept-language",
    "authorization",
    "cache-control",
    "content-type",
    "cookie",
    "pragma",
    "user-agent",
    "x-correlation-id",
    "x-request-id"
  ].map((h) => h.toLowerCase())
);

function buildTargetUrl(base: string, pathSegments: string[], searchParams: URLSearchParams): string {
  const sanitizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const path = pathSegments.map(encodeURIComponent).join("/");
  const query = searchParams.toString();
  return `${sanitizedBase}/${path}${query ? `?${query}` : ""}`;
}

function copySafeHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "content-length") {
      continue;
    }
    if (!SAFE_HEADER_NAMES.has(lower)) {
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

async function proxyRequest(
  request: NextRequest,
  params: Promise<{ path: string[] }>
): Promise<Response> {
  const backendBaseUrl = resolveBackendGatewayBaseUrl();
  if (!backendBaseUrl) {
    return NextResponse.json(
      {
        message: "Gateway misconfigured: BACKEND_GATEWAY_URL is required in production",
        code: "GATEWAY_MISCONFIGURED"
      },
      { status: 503 }
    );
  }

  const { path } = await params;
  if (!isGatewayPathAllowed(path)) {
    return NextResponse.json(
      { message: "Route not allowed through gateway proxy", code: "GATEWAY_PATH_FORBIDDEN" },
      { status: 404 }
    );
  }

  const targetUrl = buildTargetUrl(backendBaseUrl, path, request.nextUrl.searchParams);
  const headers = copySafeHeaders(request.headers);

  const method = request.method.toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(method);
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000)
    });
  } catch (err) {
    const dev = process.env.NODE_ENV === "development";
    const message =
      err instanceof Error && (err as NodeJS.ErrnoException).cause
        ? String((err as Error & { cause?: { code?: string } }).cause?.code ?? err.message)
        : err instanceof Error
          ? err.message
          : "Unknown error";
    return NextResponse.json(
      {
        message: "Upstream service unreachable",
        code: "GATEWAY_UPSTREAM_UNREACHABLE",
        ...(dev ? { targetUrl, detail: message } : {})
      },
      { status: 503 }
    );
  }

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (key.toLowerCase() === "content-encoding") {
      continue;
    }
    responseHeaders.set(key, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  return proxyRequest(request, context.params);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  return proxyRequest(request, context.params);
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  return proxyRequest(request, context.params);
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  return proxyRequest(request, context.params);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  return proxyRequest(request, context.params);
}
