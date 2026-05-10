"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Html, OrbitControls, useGLTF, useTexture } from "@react-three/drei";
import { Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  applyVisemeToMesh,
  findPrimaryVisemeMesh,
  parseMouthCueFile,
  pickMouthCue,
  rhubarbCueToOculusViseme,
  type MouthCue
} from "@/lib/avatar-mvp/mouth-cues";

/** Default test asset (MIT) — replace with `AvatarBundle.glbUrl` from CDN when integrating. */
export const DEFAULT_AVATAR_GLB_URL =
  "https://raw.githubusercontent.com/khaledalam/avatoon/main/test/assets/placeholder-avatar.glb";

useGLTF.preload(DEFAULT_AVATAR_GLB_URL);

/** Portrait in `public/` — override with `NEXT_PUBLIC_AVATAR_MVP_PHOTO_URL`. */
export const DEFAULT_PHOTO_PORTRAIT_PATH = "/arey.jpg";

function PhotoPortraitRig({
  imageUrl,
  cues,
  playing,
  speed = 1
}: {
  imageUrl: string;
  cues: MouthCue[];
  playing: boolean;
  speed?: number;
}) {
  const texture = useTexture(imageUrl);
  const root = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const simTime = useRef(0);
  const [rhubarbLetter, setRhubarbLetter] = useState("X");
  const lastLetter = useRef("X");

  const duration = useMemo(() => (cues.length ? cues[cues.length - 1]!.end : 1), [cues]);

  const { width, height } = useMemo(() => {
    const img = texture.image as HTMLImageElement | { width: number; height: number };
    const ih = Number(img.height) || 1;
    const iw = Number(img.width) || 1;
    const h = 1.85;
    const w = h * (iw / ih);
    return { width: w, height: h };
  }, [texture]);

  useLayoutEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);

  useFrame((_, delta) => {
    if (!playing) {
      return;
    }
    simTime.current += delta * speed;
    const t = simTime.current % Math.max(duration, 0.08);
    const cue = pickMouthCue(cues, t);
    const letter = (cue?.value ?? "X").toUpperCase();
    if (letter !== lastLetter.current) {
      lastLetter.current = letter;
      setRhubarbLetter(letter);
    }

    const talking = letter !== "X";
    const lipPulse = talking ? 1 + 0.018 * Math.sin(simTime.current * 21) : 1;

    if (root.current) {
      root.current.rotation.y = Math.sin(simTime.current * 1.05) * 0.1;
      root.current.rotation.x = Math.sin(simTime.current * 0.88) * 0.045;
    }
    if (meshRef.current) {
      meshRef.current.scale.set(1, lipPulse, 1);
    }
  });

  return (
    <group ref={root}>
      <mesh ref={meshRef}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      <Html center distanceFactor={2.2} position={[0, height * 0.52, 0.02]} transform occlude={false}>
        <div className="pointer-events-none rounded-md border border-white/20 bg-black/75 px-2 py-1 font-mono text-[11px] text-white shadow-lg">
          Rhubarb: <span className="text-amber-200">{rhubarbLetter}</span>
          <span className="block text-[9px] font-sans text-white/70">
            JPG — только таймлайн + «пульс»; губы по морфам → GLB / RPM
          </span>
        </div>
      </Html>
    </group>
  );
}

function AvatarRig({
  url,
  cues,
  playing,
  speed = 1
}: {
  url: string;
  cues: MouthCue[];
  playing: boolean;
  speed?: number;
}) {
  const { scene } = useGLTF(url);
  const root = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh | THREE.SkinnedMesh | null>(null);
  const simTime = useRef(0);

  const duration = useMemo(() => (cues.length ? cues[cues.length - 1]!.end : 1), [cues]);

  useLayoutEffect(() => {
    meshRef.current = findPrimaryVisemeMesh(scene);
    if (!meshRef.current) {
      console.warn("[avatar-mvp] No mesh with viseme_* morph targets — swap GLB or extend mouth-cues mapping.");
    }
  }, [scene]);

  useFrame((_, delta) => {
    if (!playing) {
      return;
    }
    simTime.current += delta * speed;
    const t = simTime.current % Math.max(duration, 0.08);
    const cue = pickMouthCue(cues, t);
    const morphName = cue ? rhubarbCueToOculusViseme(cue.value) : null;
    if (meshRef.current) {
      applyVisemeToMesh(meshRef.current, morphName, 0.9);
    }
    if (root.current) {
      root.current.rotation.y = Math.sin(simTime.current * 1.05) * 0.12;
      root.current.rotation.x = Math.sin(simTime.current * 0.85) * 0.055;
    }
  });

  return (
    <group ref={root}>
      <primitive object={scene} />
    </group>
  );
}

function Scene({
  mode,
  glbUrl,
  photoUrl,
  cues,
  playing,
  speed
}: {
  mode: "glb" | "photo";
  glbUrl: string;
  photoUrl: string;
  cues: MouthCue[];
  playing: boolean;
  speed: number;
}) {
  return (
    <>
      <ambientLight intensity={mode === "photo" ? 0.75 : 0.55} />
      <directionalLight position={[3, 6, 4]} intensity={mode === "photo" ? 0.95 : 1.1} castShadow />
      <Suspense fallback={null}>
        {mode === "glb" ? (
          <>
            <AvatarRig url={glbUrl} cues={cues} playing={playing} speed={speed} />
            <Environment preset="city" />
          </>
        ) : (
          <PhotoPortraitRig cues={cues} imageUrl={photoUrl} playing={playing} speed={speed} />
        )}
      </Suspense>
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} minDistance={1.2} maxDistance={6} />
    </>
  );
}

export function AvatarMvpSpikeCanvas() {
  const [cues, setCues] = useState<MouthCue[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [mode, setMode] = useState<"photo" | "glb">("photo");
  const [glbUrl] = useState(
    () => process.env.NEXT_PUBLIC_AVATAR_MVP_GLB_URL?.trim() || DEFAULT_AVATAR_GLB_URL
  );
  const [photoUrl] = useState(
    () => process.env.NEXT_PUBLIC_AVATAR_MVP_PHOTO_URL?.trim() || DEFAULT_PHOTO_PORTRAIT_PATH
  );

  useLayoutEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/avatar-mvp/sample-mouth-cues.json", { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json: unknown = await res.json();
        if (!cancelled) {
          setCues(parseMouthCueFile(json));
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Failed to load mouth cues");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Avatar MVP (client R3F)</CardTitle>
          <CardDescription>
            Режим <strong>2D портрет</strong> — текстура из <code className="rounded bg-muted px-1">public</code>,
            тот же Rhubarb-таймлайн, повороты + лёгкий «пульс» по шкале Y (не настоящие виземы на фото). Режим{" "}
            <strong>3D GLB</strong> — морфы <code className="rounded bg-muted px-1">viseme_*</code>. Cues:{" "}
            <a
              className="text-primary underline"
              href="https://github.com/DanielSWolf/rhubarb-lip-sync"
              rel="noreferrer"
              target="_blank"
            >
              Rhubarb
            </a>{" "}
            JSON shape · reference app{" "}
            <a
              className="text-primary underline"
              href="https://github.com/danieloquelis/chat-avatar-ai"
              rel="noreferrer"
              target="_blank"
            >
              chat-avatar-ai
            </a>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-md border p-0.5">
              <Button
                className="h-8"
                size="sm"
                type="button"
                variant={mode === "photo" ? "default" : "ghost"}
                onClick={() => setMode("photo")}
              >
                2D /arey.jpg
              </Button>
              <Button
                className="h-8"
                size="sm"
                type="button"
                variant={mode === "glb" ? "default" : "ghost"}
                onClick={() => setMode("glb")}
              >
                3D GLB
              </Button>
            </div>
            <Button type="button" variant={playing ? "default" : "secondary"} onClick={() => setPlaying((p) => !p)}>
              {playing ? "Pause" : "Play"}
            </Button>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Speed
              <input
                className="w-28 accent-primary"
                max={2.5}
                min={0.25}
                onChange={(e) => setSpeed(Number(e.target.value))}
                step={0.05}
                type="range"
                value={speed}
              />
              <span className="tabular-nums">{speed.toFixed(2)}×</span>
            </label>
          </div>
          {loadError ? (
            <p className="text-sm text-destructive">Could not load cues: {loadError}</p>
          ) : cues.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading mouth cues…</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Loaded {cues.length} cues · duration {cues[cues.length - 1]!.end.toFixed(2)}s (loop)
            </p>
          )}
        </CardContent>
      </Card>

      <div className="h-[70vh] max-h-[560px] min-h-[320px] w-full overflow-hidden rounded-lg border bg-black">
        {cues.length > 0 ? (
          <Canvas
            key={mode}
            camera={{ position: [0, 0.08, mode === "photo" ? 2.15 : 2.4], fov: 40 }}
            shadows
            dpr={[1, 2]}
          >
            <Scene cues={cues} glbUrl={glbUrl} mode={mode} photoUrl={photoUrl} playing={playing} speed={speed} />
          </Canvas>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Preparing WebGL scene…
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Фото: <span className="break-all">{photoUrl}</span> (положите файл в <code className="rounded bg-muted px-1">public/</code>{" "}
        или задайте <code className="rounded bg-muted px-1">NEXT_PUBLIC_AVATAR_MVP_PHOTO_URL</code>). GLB:{" "}
        <span className="break-all">{glbUrl}</span>.
      </p>
    </div>
  );
}
