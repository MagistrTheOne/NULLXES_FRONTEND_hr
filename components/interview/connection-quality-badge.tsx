"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectionQuality, ConnectionQualityReading } from "@/hooks/use-connection-quality";

interface ConnectionQualityBadgeProps {
  reading: ConnectionQualityReading;
  className?: string;
  hidden?: boolean;
}

const LABEL: Record<ConnectionQuality, string> = {
  excellent: "Хорошо",
  fair: "Средне",
  poor: "Плохо",
  offline: "Нет сети",
  reconnecting: "Соединение"
};

const DOT: Record<ConnectionQuality, string> = {
  excellent: "bg-emerald-500",
  fair: "bg-amber-400",
  poor: "bg-rose-500",
  offline: "bg-slate-400",
  reconnecting: "bg-sky-500 animate-pulse"
};

export function ConnectionQualityBadge({ reading, className, hidden = false }: ConnectionQualityBadgeProps) {
  if (hidden) return null;
  const { quality, rttMs, packetLossPercent, reason } = reading;
  const tooltipLines: string[] = [];
  if (typeof rttMs === "number") tooltipLines.push(`RTT: ${rttMs} мс`);
  if (typeof packetLossPercent === "number") tooltipLines.push(`Потеря пакетов: ${packetLossPercent}%`);
  if (quality === "offline") tooltipLines.push("Нет интернета — проверьте Wi-Fi / мобильную сеть");
  if (quality === "reconnecting") tooltipLines.push("Восстанавливаем соединение со Stream…");
  if (reason === "high_rtt") tooltipLines.push("Высокая задержка — переключитесь на Wi-Fi если возможно");
  if (reason === "packet_loss") tooltipLines.push("Потеря пакетов — звук может прерываться");

  return (
    <Tooltip>
      <TooltipTrigger
        className={`inline-flex select-none items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm ${
          className ?? ""
        }`}
        aria-label={`Качество соединения: ${LABEL[quality]}`}
      >
        <span className={`h-2 w-2 rounded-full ${DOT[quality]}`} />
        {LABEL[quality]}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="space-y-0.5 text-xs">
          <p className="font-semibold">{LABEL[quality]}</p>
          {tooltipLines.length === 0 ? <p className="opacity-80">Нет данных о соединении.</p> : null}
          {tooltipLines.map((line) => (
            <p key={line} className="opacity-80">
              {line}
            </p>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
