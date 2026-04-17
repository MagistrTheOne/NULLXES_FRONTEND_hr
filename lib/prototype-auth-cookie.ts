const COOKIE_NAME = "prototype_session";

function encoder(): TextEncoder {
  return new TextEncoder();
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function uint8ToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export type SessionPayload = {
  sub: string;
  exp: number;
};

export async function signSessionPayload(payload: SessionPayload, secret: string): Promise<string> {
  const body = JSON.stringify(payload);
  const bodyBytes = encoder().encode(body);
  const key = await importHmacKey(secret);
  const bodyBuf = bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer;
  const sig = await crypto.subtle.sign("HMAC", key, bodyBuf);
  return `${uint8ToBase64Url(bodyBytes)}.${uint8ToBase64Url(new Uint8Array(sig))}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [bodyB64, sigB64] = parts;
  try {
    const bodyBytes = fromBase64Url(bodyB64);
    const key = await importHmacKey(secret);
    const bodyBuf = bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer;
    const expected = await crypto.subtle.sign("HMAC", key, bodyBuf);
    const actual = fromBase64Url(sigB64);
    if (actual.length !== new Uint8Array(expected).length) {
      return null;
    }
    let diff = 0;
    const expView = new Uint8Array(expected);
    for (let i = 0; i < actual.length; i += 1) {
      diff |= actual[i] ^ expView[i];
    }
    if (diff !== 0) {
      return null;
    }
    const payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as SessionPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
      return null;
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookieName(): string {
  return COOKIE_NAME;
}
