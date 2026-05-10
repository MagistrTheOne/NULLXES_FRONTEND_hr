# Avatar MVP spike assets

## 2D portrait (`/arey.jpg`)

On `/avatar-mvp`, choose **2D /arey.jpg**: the image must live under `public/` (e.g. `public/arey.jpg`). Override with env `NEXT_PUBLIC_AVATAR_MVP_PHOTO_URL` (still a same-origin path or absolute URL your browser can load).

## Lip-sync JSON (`sample-mouth-cues.json`)

Shape matches [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync) JSON export: `mouthCues[]` with `start`, `end`, `value` (single-letter cue).

Generate from a WAV locally:

```bash
rhubarb -f json -o my-cues.json my.wav
```

Place `my.wav` in this folder if you want the spike page to play audio in sync (optional — the demo loops morphs on a clock if audio is missing).

## GLB

The spike page loads a remote placeholder GLB (see `DEFAULT_AVATAR_GLB_URL` in `components/avatar-mvp/avatar-mvp-spike-canvas.tsx`). Swap for your own `AvatarBundle` CDN URL when ready.
