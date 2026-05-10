# AvatarBundle manifest (v1 draft)

This document defines the **cold-phase** artifact referenced at runtime by `avatar_id` + `bundle_version`. It aligns with the MVP plan: **`rendering_profile: client_r3f`**, Oculus-style viseme morphs (e.g. Ready Player Me GLB), Rhubarb-compatible cue files, procedural head motion (no face tracking in v1).

## Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `format_version` | string | yes | Manifest schema version. Use `"1.0"` for this draft. |
| `bundle_id` | string | yes | Stable id of this bundle (e.g. UUID). |
| `avatar_id` | string | yes | Logical persona id (`AvatarIdentity`). |
| `checksum` | string | yes | SHA-256 of canonical JSON (excluding this field) or of packaged zip; team must pick one policy. |
| `rendering_profile` | enum | yes | `client_r3f` \| `client_2d` \| `server_light` \| `server_neuro` \| `anam` — MVP default: **`client_r3f`**. |
| `glb_url` | string (URI) | yes | HTTPS URL to `.glb` with morph targets (RPM / custom). |
| `glb_checksum` | string | optional | Digest of GLB bytes for CDN cache bust / integrity. |
| `viseme_map` | object | optional | Override Rhubarb letter → morph name; keys `A`…`H`, `X`; values morph names on mesh (e.g. `viseme_aa`). If omitted, client uses `rhubarbCueToOculusViseme` defaults from [`lib/avatar-mvp/mouth-cues.ts`](../lib/avatar-mvp/mouth-cues.ts). |
| `head_limits` | object | optional | Max radians for procedural nod / turn, e.g. `{ "yaw": 0.15, "pitch": 0.08 }`. |
| `mouth_cues_url` | string (URI) | optional | Pre-baked Rhubarb JSON for a **canonical** greeting clip; live dialogue uses runtime-generated cues. |
| `emotion_presets` | object | optional | Named blendshape snapshots for LLM-tagged moods, e.g. `{ "neutral": {...}, "smile": {...} }` — v2+; MVP may omit. |
| `created_at` | string (ISO-8601) | yes | Build timestamp. |

## Example (`avatar-bundle.manifest.example.json`)

```json
{
  "format_version": "1.0",
  "bundle_id": "bnd_01hqexample",
  "avatar_id": "avt_hr_default",
  "checksum": "<sha256-of-payload>",
  "rendering_profile": "client_r3f",
  "glb_url": "https://cdn.example.com/avatars/avt_hr_default/v3/model.glb",
  "glb_checksum": "<sha256-of-glb>",
  "viseme_map": {
    "X": "viseme_sil",
    "A": "viseme_aa",
    "B": "viseme_E",
    "C": "viseme_I",
    "D": "viseme_O",
    "E": "viseme_U",
    "F": "viseme_PP",
    "G": "viseme_FF",
    "H": "viseme_TH"
  },
  "head_limits": { "yaw": 0.15, "pitch": 0.08 },
  "mouth_cues_url": "https://cdn.example.com/avatars/avt_hr_default/v3/greeting.cues.json",
  "created_at": "2026-05-10T00:00:00.000Z"
}
```

## Rhubarb cue file (companion JSON)

Same shape as [`public/avatar-mvp/sample-mouth-cues.json`](../public/avatar-mvp/sample-mouth-cues.json): `metadata` + `mouthCues[]` with `start`, `end`, `value` (Rhubarb letter). Produced by [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync).

## JSON Schema (machine-readable)

See [`schemas/avatar-bundle.manifest.v1.schema.json`](./schemas/avatar-bundle.manifest.v1.schema.json).
