import { NextResponse, type NextRequest } from "next/server";

const backendBaseUrl = process.env.BACKEND_GATEWAY_URL ?? "http://localhost:8080";

function buildTargetUrl(pathSegments: string[], searchParams: URLSearchParams): string {
  const sanitizedBase = backendBaseUrl.endsWith("/")
    ? backendBaseUrl.slice(0, -1)
    : backendBaseUrl;
  const path = pathSegments.map(encodeURIComponent).join("/");
  const query = searchParams.toString();
  return `${sanitizedBase}/${path}${query ? `?${query}` : ""}`;
}

function copyHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "connection") {
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
  const { path } = await params;
  const targetUrl = buildTargetUrl(path, request.nextUrl.searchParams);
  const headers = copyHeaders(request.headers);

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
      signal: AbortSignal.timeout(60_000),
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
        ...(dev ? { targetUrl, detail: message } : {}),
      },
      { status: 503 },
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
