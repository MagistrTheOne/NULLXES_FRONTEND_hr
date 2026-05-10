import * as THREE from "three";

/** One interval from Rhubarb JSON (`-f json`) or compatible tooling. */
export type MouthCue = {
  start: number;
  end: number;
  /** Rhubarb mouth-cue code: A–H or X (rest). */
  value: string;
};

export type MouthCueFile = {
  metadata?: {
    soundFile?: string;
    duration?: number;
    tool?: string;
  };
  mouthCues: MouthCue[];
};

/**
 * Approximate Rhubarb single-letter cue → Ready Player Me / Oculus viseme morph name.
 * Refine per-avatar in `AvatarBundle.visemeMap` when assets differ.
 * @see https://github.com/DanielSWolf/rhubarb-lip-sync
 * @see https://docs.readyplayer.me/ready-player-me/api-reference/avatars/morph-targets/oculus-ovr-libsync
 */
export function rhubarbCueToOculusViseme(code: string): string | null {
  const v = code.trim().toUpperCase();
  switch (v) {
    case "X":
      return "viseme_sil";
    case "A":
      return "viseme_aa";
    case "B":
      return "viseme_E";
    case "C":
      return "viseme_I";
    case "D":
      return "viseme_O";
    case "E":
      return "viseme_U";
    case "F":
      return "viseme_PP";
    case "G":
      return "viseme_FF";
    case "H":
      return "viseme_TH";
    default:
      return null;
  }
}

export function parseMouthCueFile(raw: unknown): MouthCue[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const rec = raw as Record<string, unknown>;
  const cues = rec.mouthCues;
  if (!Array.isArray(cues)) {
    return [];
  }
  const out: MouthCue[] = [];
  for (const entry of cues) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const start = typeof e.start === "number" ? e.start : Number(e.start);
    const end = typeof e.end === "number" ? e.end : Number(e.end);
    const value = typeof e.value === "string" ? e.value : "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || !value) {
      continue;
    }
    out.push({ start, end, value });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function pickMouthCue(cues: MouthCue[], t: number): MouthCue | null {
  for (const cue of cues) {
    if (t >= cue.start && t < cue.end) {
      return cue;
    }
  }
  return cues.length > 0 ? cues[cues.length - 1]! : null;
}

/** Zero all Oculus-style viseme morphs on a mesh, then set one weight (0..1). */
export function applyVisemeToMesh(
  mesh: THREE.Mesh | THREE.SkinnedMesh,
  activeMorphName: string | null,
  weight = 0.92
): void {
  const dict = mesh.morphTargetDictionary;
  const infl = mesh.morphTargetInfluences;
  if (!dict || !infl) {
    return;
  }
  for (const key of Object.keys(dict)) {
    if (!key.startsWith("viseme_")) {
      continue;
    }
    const idx = dict[key];
    if (idx === undefined) {
      continue;
    }
    infl[idx] = 0;
  }
  if (!activeMorphName) {
    return;
  }
  const idx = dict[activeMorphName];
  if (idx === undefined) {
    return;
  }
  infl[idx] = weight;
}

export function findPrimaryVisemeMesh(root: THREE.Object3D): THREE.Mesh | THREE.SkinnedMesh | null {
  let best: THREE.Mesh | THREE.SkinnedMesh | null = null;
  let visemeCount = 0;
  root.traverse((obj) => {
    if (obj instanceof THREE.SkinnedMesh || obj instanceof THREE.Mesh) {
      const dict = obj.morphTargetDictionary;
      if (!dict) {
        return;
      }
      const keys = Object.keys(dict).filter((k) => k.startsWith("viseme_"));
      if (keys.length > visemeCount) {
        visemeCount = keys.length;
        best = obj;
      }
    }
  });
  return best;
}
