import type { NextRequest } from "next/server";

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

  const upstream = await fetch(targetUrl, {
    method,
    headers,
    body,
    redirect: "manual"
  });

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
