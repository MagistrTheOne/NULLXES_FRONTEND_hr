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
