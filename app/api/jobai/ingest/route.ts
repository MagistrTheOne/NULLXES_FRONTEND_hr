import { NextResponse, type NextRequest } from "next/server";

/**
 * Server-side forward to JobAI ingest webhook (minimal body: id, status).
 * Headers: Content-Type: application/json, x-jobai-ingest-secret
 */
export async function POST(request: NextRequest) {
  const url = process.env.JOBAI_INGEST_WEBHOOK_URL?.trim();
  const secret = process.env.JOBAI_INGEST_SECRET?.trim();
  if (!url || !secret) {
    return NextResponse.json({ skipped: true, reason: "JOBAI_INGEST_WEBHOOK_URL or JOBAI_INGEST_SECRET not set" });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ message: "Expected JSON object" }, { status: 400 });
  }

  const { id, status } = body as { id?: unknown; status?: unknown };
  if (typeof id !== "number" || typeof status !== "string") {
    return NextResponse.json({ message: "Expected id (number) and status (string)" }, { status: 400 });
  }

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-jobai-ingest-secret": secret,
      },
      body: JSON.stringify({ id, status }),
      signal: AbortSignal.timeout(20_000),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return NextResponse.json(
        { message: "Ingest webhook returned error", status: upstream.status, detail: text.slice(0, 500) },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ message: "Ingest webhook request failed", detail: message }, { status: 502 });
  }
}
