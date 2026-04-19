"use client";

import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

interface SessionCountdownDialogProps {
  open: boolean;
  /** Remaining ms until auto-end. Renders as mm:ss. */
  msLeft: number;
  /** Default extend amount, shown on the button label. */
  extendByMinutes: number;
  busy?: boolean;
  onExtend: () => void;
  onEndNow: () => void;
  onDismiss: () => void;
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Custom warning dialog that replaces the default GetStream session-timeout
 * notification. Shown when the candidate's session is about to auto-end —
 * gives them the option to extend (within reason) or end immediately, and
 * wires the actual countdown handling to our own stop() flow rather than
 * relying on undocumented SDK behavior.
 */
export function SessionCountdownDialog({
  open,
  msLeft,
  extendByMinutes,
  busy = false,
  onExtend,
  onEndNow,
  onDismiss
}: SessionCountdownDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onDismiss() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-slate-800">
            <Clock className="size-5 text-amber-600" />
            Видеособеседование скоро завершится
          </DialogTitle>
          <DialogDescription>
            Авто-завершение через{" "}
            <span className="font-mono text-base font-semibold text-slate-800">{formatMs(msLeft)}</span>.
            Вы можете продлить сессию, если нужно ещё время, или завершить её сейчас.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
          После авто-завершения сгенерируется итоговый отчёт и вернуться к этому собеседованию будет нельзя.
        </div>
        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onDismiss} disabled={busy}>
            Закрыть
          </Button>
          <Button type="button" variant="secondary" onClick={onExtend} disabled={busy}>
            Продлить на {extendByMinutes} мин
          </Button>
          <Button type="button" variant="destructive" onClick={onEndNow} disabled={busy}>
            Завершить сейчас
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
