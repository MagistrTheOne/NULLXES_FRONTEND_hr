"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface ThankYouScreenProps {
  candidateFirstName?: string;
  jobTitle?: string;
  companyName?: string;
}

/**
 * Финальный экран для кандидата после `phase === "completed"`.
 * Заменяет grid `Кандидат / HR аватар / Наблюдатель` чтобы кандидат не видел
 * замороженный UI с микро/камерой и не путался кнопкой «Завершить».
 */
export function ThankYouScreen({
  candidateFirstName,
  jobTitle,
  companyName
}: ThankYouScreenProps) {
  const [secondsLeft, setSecondsLeft] = useState(60);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const greeting = candidateFirstName?.trim()
    ? `Спасибо, ${candidateFirstName.trim()}!`
    : "Спасибо!";

  const subtitle =
    jobTitle && companyName
      ? `Видеособеседование на вакансию «${jobTitle}» в компанию ${companyName} завершено.`
      : "Видеособеседование завершено.";

  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <div className="rounded-3xl bg-[#d9dee7] px-10 py-12 shadow-[-12px_-12px_24px_rgba(255,255,255,.9),12px_12px_28px_rgba(163,177,198,.55)]">
        <h1 className="text-2xl font-semibold text-slate-800 sm:text-3xl">{greeting}</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg">
          {subtitle}
        </p>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-slate-500">
          HR-команда свяжется с вами в течение 5 рабочих дней по контактам, которые вы оставили в JobAI.
          Микрофон и камера уже отключены — эту вкладку можно безопасно закрыть.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <Button
            type="button"
            className="h-11 rounded-xl bg-[#3a8edb] px-8 text-sm font-semibold text-white hover:bg-[#2f7bc0]"
            onClick={() => {
              if (typeof window !== "undefined") {
                window.close();
              }
            }}
          >
            Закрыть вкладку
          </Button>
          {secondsLeft > 0 ? (
            <p className="text-xs text-slate-400">
              Если вкладка не закрылась автоматически, закройте её сами через {secondsLeft} с.
            </p>
          ) : (
            <p className="text-xs text-slate-400">Вкладку можно закрыть.</p>
          )}
        </div>
      </div>
    </main>
  );
}
