import { NextResponse, type NextRequest } from "next/server";

/**
 * Server-side forward to JobAI ingest webhook (minimal body: id, status).
 * Headers: Content-Type: application/json, x-jobai-ingest-secret
 */
export async function POST(request: NextRequest) {
  const correlationId = request.headers.get("x-correlation-id")?.trim() || crypto.randomUUID();
  const url = process.env.JOBAI_INGEST_WEBHOOK_URL?.trim();
  const secret = process.env.JOBAI_INGEST_SECRET?.trim();
  if (!url || !secret) {
    console.warn("[jobai-ingest] skipped: missing env", { correlationId });
    const response = NextResponse.json({
      skipped: true,
      reason: "JOBAI_INGEST_WEBHOOK_URL or JOBAI_INGEST_SECRET not set",
      correlationId
    });
    response.headers.set("x-correlation-id", correlationId);
    return response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    console.warn("[jobai-ingest] invalid json body", { correlationId });
    const response = NextResponse.json({ message: "Invalid JSON", correlationId }, { status: 400 });
    response.headers.set("x-correlation-id", correlationId);
    return response;
  }

  if (!body || typeof body !== "object") {
    console.warn("[jobai-ingest] invalid payload type", { correlationId });
    const response = NextResponse.json({ message: "Expected JSON object", correlationId }, { status: 400 });
    response.headers.set("x-correlation-id", correlationId);
    return response;
  }

  const { id, status } = body as { id?: unknown; status?: unknown };
  if (typeof id !== "number" || typeof status !== "string") {
    console.warn("[jobai-ingest] payload validation failed", { correlationId, id, status });
    const response = NextResponse.json(
      { message: "Expected id (number) and status (string)", correlationId },
      { status: 400 }
    );
    response.headers.set("x-correlation-id", correlationId);
    return response;
  }

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-jobai-ingest-secret": secret,
        "x-correlation-id": correlationId
      },
      body: JSON.stringify({ id, status }),
      signal: AbortSignal.timeout(20_000)
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      console.error("[jobai-ingest] upstream error", {
        correlationId,
        id,
        status,
        upstreamStatus: upstream.status
      });
      const response = NextResponse.json(
        {
          message: "Ingest webhook returned error",
          status: upstream.status,
          detail: text.slice(0, 500),
          correlationId
        },
        { status: 502 }
      );
      response.headers.set("x-correlation-id", correlationId);
      return response;
    }

    console.info("[jobai-ingest] success", { correlationId, id, status });
    const response = NextResponse.json({ ok: true, correlationId });
    response.headers.set("x-correlation-id", correlationId);
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[jobai-ingest] request failed", { correlationId, id, status, message });
    const response = NextResponse.json(
      { message: "Ingest webhook request failed", detail: message, correlationId },
      { status: 502 }
    );
    response.headers.set("x-correlation-id", correlationId);
    return response;
  }
}
