import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { JobAiSourceStatus } from "@/lib/api";

type JobAiSourceCardProps = {
  sourceStatus: JobAiSourceStatus | null;
};

function toBadgeColor(status: "active" | "queued" | "disabled"): string {
  if (status === "active") {
    return "bg-emerald-500 text-white";
  }
  if (status === "queued") {
    return "bg-amber-500 text-white";
  }
  return "bg-slate-400 text-white";
}

function isJobAiDisabled(status: JobAiSourceStatus | null): boolean {
  if (!status?.endpoints?.length) {
    return true;
  }
  return status.endpoints.every((e) => e.status === "disabled");
}

export function JobAiSourceCard({ sourceStatus }: JobAiSourceCardProps) {
  const apiOff = isJobAiDisabled(sourceStatus);

  return (
    <Card className="rounded-2xl border-0 bg-[#d9dee7] shadow-[-10px_-10px_20px_rgba(255,255,255,.9),10px_10px_22px_rgba(163,177,198,.55)]">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-slate-700">JobAI Source Integration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-slate-600">
        {apiOff ? (
          <p className="rounded-lg border border-amber-200/80 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <strong>JobAI API не настроен</strong> на gateway (переменные <code className="rounded bg-white/60 px-1">JOBAI_*</code> в{" "}
            <code className="rounded bg-white/60 px-1">.env</code> бэкенда). Список собеседований берётся только из локального
            кэша; синхронизация со Swagger недоступна.
          </p>
        ) : null}
        {(sourceStatus?.endpoints ?? []).map((endpoint) => (
          <div key={endpoint.endpoint} className="flex items-center justify-between">
            <span>{endpoint.endpoint}</span>
            <Badge className={toBadgeColor(endpoint.status)}>{endpoint.status}</Badge>
          </div>
        ))}
        <p className="rounded-lg bg-white/50 px-3 py-2 text-xs text-slate-500">
          Payload storing mode: 1:1 raw JSON + table projection.
        </p>
        <p className="rounded-lg bg-white/50 px-3 py-2 text-xs text-slate-500">
          Last sync: {sourceStatus?.sync.lastSyncAt ? new Date(sourceStatus.sync.lastSyncAt).toLocaleString("ru-RU") : "—"}
          {" · "}
          Result: {sourceStatus?.sync.lastSyncResult ?? "idle"}
          {" · "}
          Stored: {sourceStatus?.sync.storedCount ?? 0}
        </p>
        {sourceStatus?.sync.lastSyncError ? (
          <p className="rounded-lg bg-rose-100 px-3 py-2 text-xs text-rose-700">{sourceStatus.sync.lastSyncError}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
