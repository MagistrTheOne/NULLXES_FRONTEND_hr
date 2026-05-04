"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { cleanupBeforeLogout } from "@/lib/logout-cleanup";

type SignOutButtonProps = {
  confirmBeforeLogout?: boolean;
};

export function SignOutButton({ confirmBeforeLogout = true }: SignOutButtonProps) {
  const router = useRouter();
  const inFlightRef = useRef(false);
  const [loadingStage, setLoadingStage] = useState<"idle" | "ending" | "logging_out">("idle");
  const [error, setError] = useState<string | null>(null);

  const loadingLabel =
    loadingStage === "ending"
      ? "Завершаем сессию…"
      : loadingStage === "logging_out"
        ? "Выходим…"
        : "Выйти";

  const runLogout = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setError(null);
    setLoadingStage("ending");

    try {
      await cleanupBeforeLogout();
      setLoadingStage("logging_out");

      await authClient.signOut({
        fetchOptions: {
          onSuccess: () => {
            router.replace("/sign-in?signedOut=1");
            router.refresh();
          },
          onError: () => {
            setError("Не удалось выйти. Попробуйте снова.");
          },
        },
      });
    } catch {
      setError("Не удалось выйти. Попробуйте снова.");
    } finally {
      inFlightRef.current = false;
      setLoadingStage("idle");
    }
  }, [router]);

  const onClick = useCallback(async () => {
    if (inFlightRef.current || loadingStage !== "idle") {
      return;
    }
    if (confirmBeforeLogout) {
      const ok = window.confirm(
        "Несохранённый прогресс в открытых вкладках может быть потерян. Выйти сейчас?"
      );
      if (!ok) {
        return;
      }
    }
    await runLogout();
  }, [confirmBeforeLogout, loadingStage, runLogout]);

  const busy = loadingStage !== "idle";

  return (
    <div className="inline-flex flex-col items-stretch gap-2">
      <button
        type="button"
        disabled={busy}
        aria-label={busy ? "Выход, подождите" : "Выйти из аккаунта"}
        aria-busy={busy}
        onClick={() => void onClick()}
        className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? loadingLabel : "Выйти"}
      </button>
      <span className="sr-only" aria-live="polite">
        {busy ? loadingLabel : ""}
      </span>
      {error ? (
        <p role="alert" className="max-w-[220px] text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
