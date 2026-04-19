"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

export type ExitConfirmationMode = "leave" | "end";

interface ExitConfirmationDialogProps {
  mode: ExitConfirmationMode;
  open: boolean;
  busy?: boolean;
  rejoinWindowSeconds?: number;
  onCancel: () => void;
  onConfirm: () => void;
}

const COPY: Record<ExitConfirmationMode, { title: string; descBase: string; confirm: string; tone: "secondary" | "destructive" }> = {
  leave: {
    title: "Выйти из видеособеседования?",
    descBase:
      "Вы можете выйти временно. Соединение закроется, микрофон и камера выключатся, но прогресс сохранится.",
    confirm: "Выйти временно",
    tone: "secondary"
  },
  end: {
    title: "Завершить интервью досрочно?",
    descBase:
      "Это действие финальное: meeting закроется, агент сгенерирует итоговый отчёт, вернуться к этому собеседованию будет нельзя.",
    confirm: "Завершить и отправить отчёт",
    tone: "destructive"
  }
};

export function ExitConfirmationDialog({
  mode,
  open,
  busy = false,
  rejoinWindowSeconds = 60,
  onCancel,
  onConfirm
}: ExitConfirmationDialogProps) {
  const copy = COPY[mode];
  const description =
    mode === "leave"
      ? `${copy.descBase} У вас будет ${rejoinWindowSeconds} секунд, чтобы вернуться по той же ссылке без потери места в очереди.`
      : copy.descBase;
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Отмена
          </Button>
          <Button type="button" variant={copy.tone} onClick={onConfirm} disabled={busy}>
            {busy ? "Подождите…" : copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
