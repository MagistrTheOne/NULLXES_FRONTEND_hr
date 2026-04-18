"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function StartDemoButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {error ? (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={loading}
        onClick={async () => {
          setError(null);
          setLoading(true);
          try {
            const res = await fetch("/api/demo/start", { method: "POST" });
            if (!res.ok) {
              setError("Could not start demo");
              return;
            }
            router.refresh();
          } finally {
            setLoading(false);
          }
        }}
        className="inline-flex w-full items-center justify-center rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50"
      >
        {loading ? "Starting…" : "Try without signing up"}
      </button>
    </div>
  );
}
