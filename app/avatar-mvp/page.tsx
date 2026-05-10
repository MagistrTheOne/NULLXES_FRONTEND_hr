import dynamic from "next/dynamic";

const AvatarMvpSpikeCanvas = dynamic(
  () => import("@/components/avatar-mvp/avatar-mvp-spike-canvas").then((m) => m.AvatarMvpSpikeCanvas),
  { ssr: false, loading: () => <p className="p-6 text-sm text-muted-foreground">Loading 3D view…</p> }
);

export const metadata = {
  title: "Avatar MVP spike | NULLXES HR AI"
};

export default function AvatarMvpPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4 md:p-8">
      <AvatarMvpSpikeCanvas />
    </main>
  );
}
