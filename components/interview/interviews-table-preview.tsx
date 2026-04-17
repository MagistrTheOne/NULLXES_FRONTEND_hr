"use client";

import { useCallback, useState } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getInterviewById, type InterviewDetail, type InterviewListRow } from "@/lib/api";
import { withCandidateEntryQuery } from "@/lib/candidate-entry-url";

type InterviewsTablePreviewProps = {
  rows: InterviewListRow[];
  page: number;
  pageSize: number;
  totalCount: number;
  selectedInterviewId: number | null;
  duplicateJobAiIds?: number[];
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  onSelect?: (row: InterviewListRow) => void;
  onPageChange?: (nextPage: number) => void;
};

function resolveNullxesBadge(row: InterviewListRow): { key: string; label: string } {
  const explicitLabel = typeof row.nullxesBusinessLabel === "string" ? row.nullxesBusinessLabel.trim() : "";
  const explicitKey = typeof row.nullxesBusinessKey === "string" ? row.nullxesBusinessKey.trim() : "";
  if (explicitLabel) {
    return { key: explicitKey || "business_status", label: explicitLabel };
  }

  const runtimeStatus = typeof row.nullxesStatus === "string" ? row.nullxesStatus : "";
  const jobAiStatus = typeof row.jobAiStatus === "string" ? row.jobAiStatus : "";
  const status = runtimeStatus || jobAiStatus;
  switch (status) {
    case "in_meeting":
      return { key: "meeting_in_progress", label: "В процессе" };
    case "completed":
      return { key: "completed", label: "Завершена" };
    case "stopped_during_meeting":
      return { key: "stopped_mid_meeting", label: "Остановлена" };
    case "failed":
      return { key: "start_error", label: "Ошибка старта" };
    case "canceled":
      return { key: "canceled", label: "Отменена" };
    case "received":
      return { key: "accepted_by_ai", label: "Принята ИИ системой" };
    case "pending":
      return { key: "awaiting_registration", label: "Ожидает" };
    default:
      return { key: "unknown", label: "—" };
  }
}

function openPath(path: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.open(`${window.location.origin}${path}`, "_blank", "noopener,noreferrer");
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text);
  toast.success("Скопировано", {
    description: "Ссылка сохранена в буфер обмена."
  });
}

function sanitizeEntryPath(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const candidate = value.trim();
  if (!candidate || candidate === "undefined" || candidate === "null") {
    return "";
  }
  return candidate;
}

function normalizeEntryPath(pathOrUrl: string): string {
  if (!pathOrUrl) {
    return "";
  }
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith("/")) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith("?")) {
    return `/${pathOrUrl}`;
  }
  return `/${pathOrUrl}`;
}

function toAbsoluteUrl(pathOrUrl: string): string {
  if (typeof window === "undefined") {
    return pathOrUrl;
  }
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  return `${window.location.origin}${pathOrUrl}`;
}

function buildCandidateEntryPath(row: InterviewListRow): string {
  const direct = normalizeEntryPath(sanitizeEntryPath(row.candidateEntryPath));
  const fallbackJobAiId = Number.isInteger(row.jobAiId) && row.jobAiId > 0 ? row.jobAiId : null;
  const base = direct || (fallbackJobAiId ? `/?jobAiId=${encodeURIComponent(fallbackJobAiId)}` : "/");
  return base === "/" ? base : withCandidateEntryQuery(base);
}

function buildSpectatorEntryPath(row: InterviewListRow): string {
  const direct = normalizeEntryPath(sanitizeEntryPath(row.spectatorEntryPath));
  const fallbackJobAiId = Number.isInteger(row.jobAiId) && row.jobAiId > 0 ? row.jobAiId : null;
  return direct || (fallbackJobAiId ? `/spectator?jobAiId=${encodeURIComponent(fallbackJobAiId)}` : "/spectator");
}

export function InterviewsTablePreview({
  rows,
  page,
  pageSize,
  totalCount,
  selectedInterviewId,
  duplicateJobAiIds = [],
  loading = false,
  error = null,
  onRefresh,
  onSelect,
  onPageChange
}: InterviewsTablePreviewProps) {
  const showSpectatorActions = process.env.NEXT_PUBLIC_ENABLE_SPECTATOR !== "0";
  const showInternalDebugUi = process.env.NEXT_PUBLIC_INTERNAL_DEBUG_UI === "1";
  const [refOpen, setRefOpen] = useState(false);
  const [refBusy, setRefBusy] = useState(false);
  const [refDetail, setRefDetail] = useState<InterviewDetail | null>(null);
  const [refError, setRefError] = useState<string | null>(null);

  const openReference = useCallback(async (jobAiId: number) => {
    setRefBusy(true);
    setRefError(null);
    setRefOpen(true);
    try {
      const detail = await getInterviewById(jobAiId, true);
      setRefDetail(detail);
    } catch (err) {
      setRefDetail(null);
      setRefError(err instanceof Error ? err.message : "Не удалось загрузить данные");
    } finally {
      setRefBusy(false);
    }
  }, []);

  const orderedQuestions =
    refDetail?.interview.specialty?.questions
      ?.slice()
      .sort((a: { order: number }, b: { order: number }) => a.order - b.order) ?? [];
  const totalPages = Math.max(1, Math.ceil(totalCount / Math.max(1, pageSize)));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pageButtons = (() => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const items = new Set<number>();
    items.add(1);
    items.add(totalPages);
    items.add(safePage);
    items.add(Math.max(1, safePage - 1));
    items.add(Math.min(totalPages, safePage + 1));
    return Array.from(items).sort((a, b) => a - b);
  })();

  return (
    <Card className="rounded-2xl border-0 bg-[#d9dee7] shadow-[-10px_-10px_20px_rgba(255,255,255,.9),10px_10px_22px_rgba(163,177,198,.55)]">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base text-slate-700">Список собеседований</CardTitle>
        <Button size="sm" variant="secondary" onClick={onRefresh} disabled={loading}>
          {loading ? "Обновление..." : "Обновить"}
        </Button>
      </CardHeader>
      <CardContent>
        {error ? <p className="mb-3 rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
        <div className="overflow-x-auto rounded-xl bg-white/50">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID Nullxes</TableHead>
                <TableHead>ID JobAI</TableHead>
                <TableHead>Имя</TableHead>
                <TableHead>Фамилия</TableHead>
                <TableHead>Компания</TableHead>
                <TableHead>meetingAt</TableHead>
                <TableHead>Nullxes</TableHead>
                <TableHead>JobAI</TableHead>
                <TableHead className="text-right">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-slate-500">
                    Нет загруженных интервью
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((row) => {
                const nullxesBadge = resolveNullxesBadge(row);
                const candidateEntryPath = buildCandidateEntryPath(row);
                const spectatorEntryPath = buildSpectatorEntryPath(row);
                return (
                  <TableRow key={row.jobAiId} className={selectedInterviewId === row.jobAiId ? "bg-sky-100/40" : ""}>
                  <TableCell className="font-medium">{row.nullxesMeetingId ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span>{row.jobAiId}</span>
                      {duplicateJobAiIds.includes(row.jobAiId) ? (
                        <Badge variant="secondary" className="bg-amber-100 text-amber-900">
                          возможный дубль
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>{row.candidateFirstName}</TableCell>
                  <TableCell>{row.candidateLastName}</TableCell>
                  <TableCell>{row.companyName}</TableCell>
                  <TableCell>{new Date(row.meetingAt).toLocaleString("ru-RU")}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" title={nullxesBadge.key}>
                      {nullxesBadge.label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{row.jobAiStatus}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          onSelect?.(row);
                          void openReference(row.jobAiId);
                        }}
                        disabled={refBusy}
                      >
                        Детали
                      </Button>
                      {showInternalDebugUi ? (
                        <Button size="sm" variant="secondary" onClick={() => void openReference(row.jobAiId)} disabled={refBusy}>
                          Справочно
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          if (typeof window === "undefined") {
                            return;
                          }
                          copyText(toAbsoluteUrl(candidateEntryPath));
                        }}
                      >
                        Ссылка кандидата
                      </Button>
                      {showSpectatorActions ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              if (typeof window === "undefined") {
                                return;
                              }
                              copyText(toAbsoluteUrl(spectatorEntryPath));
                            }}
                          >
                            Ссылка наблюдателя
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => openPath(spectatorEntryPath)}>
                            Вход наблюдателя
                          </Button>
                          <Button
                            size="icon"
                            variant="secondary"
                            aria-label="Открыть наблюдателя"
                            onClick={() => openPath(spectatorEntryPath)}
                          >
                            <ExternalLink className="size-4" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {totalPages > 1 ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-600">
              Страница {safePage} из {totalPages} • записей: {totalCount}
            </p>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="secondary"
                disabled={loading || safePage <= 1}
                onClick={() => onPageChange?.(safePage - 1)}
              >
                Назад
              </Button>
              {pageButtons.map((pageNumber, index) => {
                const prev = pageButtons[index - 1];
                const showGap = typeof prev === "number" && pageNumber - prev > 1;
                return (
                  <div key={`page-${pageNumber}`} className="flex items-center gap-1">
                    {showGap ? <span className="px-1 text-slate-400">…</span> : null}
                    <Button
                      size="sm"
                      variant={pageNumber === safePage ? "default" : "secondary"}
                      disabled={loading}
                      onClick={() => onPageChange?.(pageNumber)}
                    >
                      {pageNumber}
                    </Button>
                  </div>
                );
              })}
              <Button
                size="sm"
                variant="secondary"
                disabled={loading || safePage >= totalPages}
                onClick={() => onPageChange?.(safePage + 1)}
              >
                Далее
              </Button>
            </div>
          </div>
        ) : null}

        <Dialog open={refOpen} onOpenChange={setRefOpen}>
          <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Справочно по собеседованию</DialogTitle>
              <DialogDescription>JobAI ID: {refDetail?.interview.id ?? "—"}</DialogDescription>
            </DialogHeader>
            {refError ? <p className="text-sm text-rose-700">{refError}</p> : null}
            {refDetail ? (
              <div className="space-y-4 text-sm text-slate-600">
                <div>
                  <p className="font-medium text-slate-700">Вакансия (vacancyText)</p>
                  <p className="mt-1 whitespace-pre-wrap rounded-lg bg-white/60 p-2">{refDetail.interview.vacancyText ?? "—"}</p>
                </div>
                <div>
                  <p className="font-medium text-slate-700">Приветствие</p>
                  <p className="mt-1 whitespace-pre-wrap rounded-lg bg-white/60 p-2">
                    {refDetail.interview.greetingSpeechResolved ?? refDetail.interview.greetingSpeech ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="font-medium text-slate-700">Прощание</p>
                  <p className="mt-1 whitespace-pre-wrap rounded-lg bg-white/60 p-2">
                    {refDetail.interview.finalSpeechResolved ?? refDetail.interview.finalSpeech ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="font-medium text-slate-700">Вопросы (specialty.questions)</p>
                  <ol className="mt-1 list-decimal space-y-1 pl-5">
                    {orderedQuestions.length === 0 ? <li className="text-slate-500">Нет вопросов</li> : null}
                    {orderedQuestions.map((q: { text: string; order: number }) => (
                      <li key={`${q.order}-${q.text}`}>{q.text}</li>
                    ))}
                  </ol>
                </div>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
