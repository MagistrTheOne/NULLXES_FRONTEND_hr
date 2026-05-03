"use client";

import { useCallback, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  getInterviewById,
  isApiRequestError,
  issueCandidateJoinLink,
  issueSpectatorJoinLink,
  type InterviewDetail,
  type InterviewListRow,
  type JoinLinkRole
} from "@/lib/api";

function normalizeText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function buildReferenceClipboardText(detail: InterviewDetail, orderedQuestions: { text: string; order: number }[]): string {
  const vacancyText = normalizeText(detail.interview.vacancyText);
  const greeting = normalizeText(detail.interview.greetingSpeechResolved ?? detail.interview.greetingSpeech);
  const finalSpeech = normalizeText(detail.interview.finalSpeechResolved ?? detail.interview.finalSpeech);
  const questionsText = orderedQuestions.map((q) => `- ${q.text}`).join("\n").trim();
  return [
    `JobAI ID: ${detail.interview.id}`,
    "",
    "Вакансия (vacancyText)",
    vacancyText || "—",
    "",
    "Приветствие",
    greeting || "—",
    "",
    "Прощание",
    finalSpeech || "—",
    "",
    "Вопросы (specialty.questions)",
    questionsText || "—"
  ].join("\n");
}

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
  onEntryUrlCopied?: (absoluteUrl: string) => void;
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
  onPageChange,
  onEntryUrlCopied
}: InterviewsTablePreviewProps) {
  const showSpectatorActions = process.env.NEXT_PUBLIC_ENABLE_SPECTATOR !== "0";
  const showInternalDebugUi = process.env.NEXT_PUBLIC_INTERNAL_DEBUG_UI === "1";
  const [refOpen, setRefOpen] = useState(false);
  const [refBusy, setRefBusy] = useState(false);
  const [refDetail, setRefDetail] = useState<InterviewDetail | null>(null);
  const [refError, setRefError] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState<Record<string, boolean>>({});

  const issueAndCopyLink = useCallback(
    async (role: JoinLinkRole, row: InterviewListRow): Promise<void> => {
      if (typeof window === "undefined") return;
      const busyKey = `${role}:${row.jobAiId}`;
      if (linkBusy[busyKey]) return;
      setLinkBusy((prev) => ({ ...prev, [busyKey]: true }));
      try {
        const issuer = role === "candidate" ? issueCandidateJoinLink : issueSpectatorJoinLink;
        const result = await issuer(row.jobAiId);
        await navigator.clipboard.writeText(result.url).catch(() => undefined);
        onEntryUrlCopied?.(result.url);
        const expires = new Date(result.expiresAt).toLocaleString("ru-RU");
        toast.success(
          role === "candidate" ? "Ссылка кандидата скопирована" : "Ссылка наблюдателя скопирована",
          {
            description: `Подписанная ссылка действительна до ${expires}. Только тот, кому вы её отправите, сможет войти.`
          }
        );
      } catch (err) {
        const message = isApiRequestError(err) ? `${err.status ?? "—"} ${err.message}` : (err as Error).message;
        toast.error("Не удалось выпустить ссылку", { description: message });
      } finally {
        setLinkBusy((prev) => {
          const next = { ...prev };
          delete next[busyKey];
          return next;
        });
      }
    },
    [linkBusy, onEntryUrlCopied]
  );

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
    <Card className="min-w-0 rounded-2xl border-0 bg-[#d9dee7] shadow-[-10px_-10px_20px_rgba(255,255,255,.9),10px_10px_22px_rgba(163,177,198,.55)]">
      <CardHeader className="flex flex-col gap-3 pb-2 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        <CardTitle className="text-base text-slate-700">Список собеседований</CardTitle>
        <Button size="sm" variant="secondary" className="h-10 w-full shrink-0 sm:h-9 sm:w-auto" onClick={onRefresh} disabled={loading}>
          {loading ? "Обновление..." : "Обновить"}
        </Button>
      </CardHeader>
      <CardContent>
        {error ? <p className="mb-3 rounded-lg bg-rose-100 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
        <div className="min-w-0 overflow-x-hidden rounded-xl bg-white/50">
          <Table className="w-full table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[220px]">ID Nullxes</TableHead>
                <TableHead className="w-[90px]">ID JobAI</TableHead>
                <TableHead className="w-[120px]">Имя</TableHead>
                <TableHead className="w-[140px]">Фамилия</TableHead>
                <TableHead>Компания</TableHead>
                <TableHead className="w-[170px]">meetingAt</TableHead>
                <TableHead className="w-[130px]">Nullxes</TableHead>
                <TableHead className="w-[120px]">JobAI</TableHead>
                <TableHead className="w-[220px] text-right">Действия</TableHead>
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
                void buildSpectatorEntryPath;
                return (
                  <TableRow key={row.jobAiId} className={selectedInterviewId === row.jobAiId ? "bg-sky-100/40" : ""}>
                  <TableCell className="font-medium">
                    <span className="block max-w-full truncate">{row.nullxesMeetingId ?? "—"}</span>
                  </TableCell>
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
                  <TableCell>
                    <span className="block max-w-full truncate">{row.companyName}</span>
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-full truncate">{new Date(row.meetingAt).toLocaleString("ru-RU")}</span>
                  </TableCell>
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
                        onClick={() => void issueAndCopyLink("candidate", row)}
                        disabled={Boolean(linkBusy[`candidate:${row.jobAiId}`])}
                      >
                        {linkBusy[`candidate:${row.jobAiId}`] ? "Выпуск ссылки…" : "Ссылка кандидата"}
                      </Button>
                      {showSpectatorActions ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void issueAndCopyLink("spectator", row)}
                            disabled={Boolean(linkBusy[`spectator:${row.jobAiId}`])}
                          >
                            {linkBusy[`spectator:${row.jobAiId}`] ? "Выпуск ссылки…" : "Ссылка наблюдателя"}
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
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/60 p-2">
                  <div className="text-xs text-slate-600">
                    <span className="font-medium text-slate-700">Сводка:</span>{" "}
                    {orderedQuestions.length > 0 ? `вопросов ${orderedQuestions.length}` : "вопросов нет"}
                    {normalizeText(refDetail.interview.vacancyText) ? ` · vacancyText ${normalizeText(refDetail.interview.vacancyText).length} символов` : ""}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8 gap-2 rounded-lg px-3 text-xs"
                    onClick={() => {
                      const text = buildReferenceClipboardText(refDetail, orderedQuestions);
                      void navigator.clipboard
                        .writeText(text)
                        .then(() => toast.success("Скопировано", { description: "Детали собеседования в буфере обмена." }))
                        .catch(() => toast.error("Не удалось скопировать"));
                    }}
                  >
                    <Copy className="size-4" aria-hidden />
                    Копировать всё
                  </Button>
                </div>

                <Accordion multiple defaultValue={["vacancy"]}>
                  <AccordionItem value="vacancy">
                    <AccordionTrigger>Вакансия (vacancyText)</AccordionTrigger>
                    <AccordionContent>
                      <p className="whitespace-pre-wrap rounded-lg bg-white/60 p-2">
                        {refDetail.interview.vacancyText ?? "—"}
                      </p>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="greeting">
                    <AccordionTrigger>Приветствие</AccordionTrigger>
                    <AccordionContent>
                      <p className="whitespace-pre-wrap rounded-lg bg-white/60 p-2">
                        {refDetail.interview.greetingSpeechResolved ?? refDetail.interview.greetingSpeech ?? "—"}
                      </p>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="questions">
                    <AccordionTrigger>Вопросы (specialty.questions)</AccordionTrigger>
                    <AccordionContent>
                      <ol className="list-decimal space-y-1 pl-5">
                        {orderedQuestions.length === 0 ? <li className="text-slate-500">Нет вопросов</li> : null}
                        {orderedQuestions.map((q: { text: string; order: number }) => (
                          <li key={`${q.order}-${q.text}`}>{q.text}</li>
                        ))}
                      </ol>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="final">
                    <AccordionTrigger>Прощание</AccordionTrigger>
                    <AccordionContent>
                      <p className="whitespace-pre-wrap rounded-lg bg-white/60 p-2">
                        {refDetail.interview.finalSpeechResolved ?? refDetail.interview.finalSpeech ?? "—"}
                      </p>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
