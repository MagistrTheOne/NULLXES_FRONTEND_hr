export function loadPrototypeUsers(): Map<string, string> {
  const map = new Map<string, string>();
  const multi = process.env.PROTOTYPE_BASIC_AUTH?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  for (const entry of multi) {
    const idx = entry.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const user = entry.slice(0, idx).trim();
    const pass = entry.slice(idx + 1);
    if (user && pass) {
      map.set(user, pass);
    }
  }
  const singleUser = process.env.PROTOTYPE_BASIC_USER?.trim();
  const singlePass = process.env.PROTOTYPE_BASIC_PASSWORD;
  if (singleUser && singlePass) {
    map.set(singleUser, singlePass);
  }
  return map;
}

export function isPrototypeAuthConfigured(): boolean {
  return loadPrototypeUsers().size > 0 && Boolean(process.env.PROTOTYPE_SESSION_SECRET?.trim());
}
