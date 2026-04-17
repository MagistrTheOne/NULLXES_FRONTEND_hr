import { Mic, Video } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { StreamParticipantShell } from "@/components/interview/stream-participant-shell";

type ParticipantCardProps = {
  roleLabel: string;
  participantName: string;
  imageSrc?: string;
  placeholder?: boolean;
  showControls?: boolean;
  primaryActionLabel?: string;
  secondaryActionLabel?: string;
  onPrimaryAction?: () => void;
  onSecondaryAction?: () => void;
  controlsDisabled?: boolean;
};

export function ParticipantCard({
  roleLabel,
  participantName,
  imageSrc,
  placeholder = false,
  showControls = true,
  primaryActionLabel = "Выйти",
  secondaryActionLabel = "Завершить",
  onPrimaryAction,
  onSecondaryAction,
  controlsDisabled = false
}: ParticipantCardProps) {
  return (
    <StreamParticipantShell
      title={roleLabel}
      footer={
        showControls ? (
          <>
            <p className="min-h-5 truncate text-left text-sm leading-snug text-slate-500">{participantName}</p>
            <div className="flex items-center gap-4 text-slate-500">
              <Mic size={18} />
              <Video size={18} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={controlsDisabled}
                onClick={onPrimaryAction}
                className="rounded-xl bg-[#d9dee7] px-5 text-slate-600 shadow-[-6px_-6px_12px_rgba(255,255,255,.85),6px_6px_12px_rgba(163,177,198,.5)] hover:bg-[#d5dbe4]"
              >
                {primaryActionLabel}
              </Button>
              <Button
                variant="secondary"
                disabled={controlsDisabled}
                onClick={onSecondaryAction}
                className="rounded-xl bg-[#d9dee7] px-5 text-slate-600 shadow-[-6px_-6px_12px_rgba(255,255,255,.85),6px_6px_12px_rgba(163,177,198,.5)] hover:bg-[#d5dbe4]"
              >
                {secondaryActionLabel}
              </Button>
            </div>
          </>
        ) : (
          <p className="min-h-5 truncate text-left text-sm text-slate-500">{participantName}</p>
        )
      }
    >
      {placeholder ? (
        <div className="flex h-full items-center justify-center text-sm text-slate-400">Нет видео</div>
      ) : (
        <Avatar className="h-full w-full rounded-none">
          <AvatarImage src={imageSrc} alt={participantName} className="h-full w-full object-cover" />
          <AvatarFallback className="rounded-none bg-[#cfd5df] text-slate-500">
            {participantName
              .split(" ")
              .map((item) => item[0])
              .join("")
              .slice(0, 2)}
          </AvatarFallback>
        </Avatar>
      )}
    </StreamParticipantShell>
  );
}
