import type { InterviewListRow, JobAiInterviewStatus, NullxesBusinessKey } from "@/lib/api";
import { isGatewayPlaceholderMeetingId, isGatewayPlaceholderSessionId } from "@/lib/gateway-projection-sanitize";

const NULLXES_BUSINESS_KEYS = new Set<string>([
  "awaiting_registration",
  "accepted_by_ai",
  "meeting_in_progress",
  "canceled",
  "stopped_mid_meeting",
  "completed",
  "start_error"
]);

const JOB_AI_STATUSES = new Set<string>([
  "pending",
  "received",
  "in_meeting",
  "completed",
  "stopped_during_meeting",
  "canceled",
  "meeting_not_started"
]);

const NULLXES_RUNTIME = new Set<string>(["idle", "in_meeting", "completed", "stopped_during_meeting", "failed"]);

function coerceBusinessKey(v: string): NullxesBusinessKey {
  return NULLXES_BUSINESS_KEYS.has(v) ? (v as NullxesBusinessKey) : "awaiting_registration";
}

function coerceJobAiStatus(v: string): JobAiInterviewStatus {
  return JOB_AI_STATUSES.has(v) ? (v as JobAiInterviewStatus) : "pending";
}

function coerceNullxesStatus(v: string): InterviewListRow["nullxesStatus"] {
  return NULLXES_RUNTIME.has(v) ? (v as InterviewListRow["nullxesStatus"]) : "idle";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = str(obj[k]);
    if (v) {
      return v;
    }
  }
  return "";
}

/**
 * Одна строка «ФИО в одном поле» (JobAI / gateway): кириллица чаще «Фамилия Имя …»,
 * латиница чаще «First Last».
 */
export function splitCombinedCandidateName(combined: string): { candidateFirstName: string; candidateLastName: string } {
  const t = combined.trim();
  if (!t) {
    return { candidateFirstName: "", candidateLastName: "" };
  }
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { candidateFirstName: "", candidateLastName: parts[0] };
  }
  const hasCyrillic = /[\u0400-\u04FF]/.test(t);
  if (hasCyrillic) {
    const lastName = parts[0];
    const candidateFirstName = parts.slice(1).join(" ");
    return { candidateFirstName, candidateLastName: lastName };
  }
  if (parts.length === 2) {
    return { candidateFirstName: parts[0], candidateLastName: parts[1] };
  }
  return { candidateFirstName: parts[0], candidateLastName: parts.slice(1).join(" ") };
}

function flattenGatewayRow(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const projection = raw.projection;
  if (projection && typeof projection === "object") {
    for (const [k, v] of Object.entries(projection as Record<string, unknown>)) {
      if (k === "nullxesMeetingId" || k === "nullxes_meeting_id") {
        const sv = str(v);
        if (isGatewayPlaceholderMeetingId(sv)) {
          continue;
        }
      }
      if (k === "sessionId" || k === "session_id") {
        const sv = str(v);
        if (isGatewayPlaceholderSessionId(sv)) {
          continue;
        }
      }
      if (out[k] === undefined || out[k] === null || out[k] === "") {
        out[k] = v;
      }
    }
  }
  const prototypeCandidate = raw.prototypeCandidate;
  if (prototypeCandidate && typeof prototypeCandidate === "object") {
    const p = prototypeCandidate as Record<string, unknown>;
    if (!str(out.candidateFirstName) && str(p.candidateFirstName)) {
      out.candidateFirstName = p.candidateFirstName;
    }
    if (!str(out.candidateLastName) && str(p.candidateLastName)) {
      out.candidateLastName = p.candidateLastName;
    }
    if (!pickStr(out, ["candidateFirstName", "candidate_first_name", "firstName"]) && !pickStr(out, ["candidateLastName", "candidate_last_name", "lastName"])) {
      const full = str(p.sourceFullName);
      if (full) {
        const sp = splitCombinedCandidateName(full);
        out.candidateFirstName = sp.candidateFirstName;
        out.candidateLastName = sp.candidateLastName;
      }
    }
  }

  const interview = raw.interview;
  if (interview && typeof interview === "object") {
    const inv = interview as Record<string, unknown>;
    for (const k of [
      "candidateFirstName",
      "candidateLastName",
      "candidate_first_name",
      "candidate_last_name",
      "candidateName",
      "candidateFullName",
      "fullName",
      "companyName",
      "meetingAt",
      "jobTitle"
    ]) {
      if ((out[k] === undefined || out[k] === null || out[k] === "") && str(inv[k])) {
        out[k] = inv[k];
      }
    }
  }
  return out;
}

function resolveCandidateNames(f: Record<string, unknown>): { candidateFirstName: string; candidateLastName: string } {
  let first = pickStr(f, ["candidateFirstName", "candidate_first_name", "firstName", "firstname", "givenName"]);
  let last = pickStr(f, ["candidateLastName", "candidate_last_name", "lastName", "lastname", "familyName", "surname"]);
  if (!first && !last) {
    const combined = pickStr(f, [
      "candidateName",
      "candidateFullName",
      "fullName",
      "candidate_full_name",
      "name",
      "fio",
      "ФИО"
    ]);
    const sp = splitCombinedCandidateName(combined);
    first = sp.candidateFirstName;
    last = sp.candidateLastName;
  }
  return { candidateFirstName: first, candidateLastName: last };
}

/**
 * Приводит элемент из `GET /interviews` к виду `InterviewListRow`: gateway/JobAI
 * иногда отдают только `candidateName`, snake_case или вложенный `interview` / `projection`.
 */
export function normalizeInterviewListRow(raw: unknown): InterviewListRow {
  if (!raw || typeof raw !== "object") {
    return {
      jobAiId: 0,
      candidateFirstName: "",
      candidateLastName: "",
      candidateEntryPath: "",
      spectatorEntryPath: "",
      nullxesBusinessKey: "awaiting_registration",
      nullxesBusinessLabel: "",
      companyName: "",
      meetingAt: "",
      jobAiStatus: "pending",
      nullxesStatus: "idle",
      updatedAt: "",
      createdAt: ""
    };
  }
  const r = raw as Record<string, unknown>;
  const f = flattenGatewayRow(r);
  const names = resolveCandidateNames(f);

  const jobAiIdRaw = f.jobAiId ?? f.id ?? f.job_ai_id;
  const jobAiId = typeof jobAiIdRaw === "number" && Number.isInteger(jobAiIdRaw) ? jobAiIdRaw : Number(jobAiIdRaw);

  let nullxesMeetingId = str(f.nullxesMeetingId ?? f.nullxes_meeting_id ?? f.meetingId);
  let sessionId = str(f.sessionId ?? f.session_id);
  if (isGatewayPlaceholderMeetingId(nullxesMeetingId)) {
    nullxesMeetingId = "";
  }
  if (isGatewayPlaceholderSessionId(sessionId)) {
    sessionId = "";
  }

  return {
    jobAiId: Number.isInteger(jobAiId) && jobAiId > 0 ? jobAiId : 0,
    nullxesMeetingId: nullxesMeetingId || undefined,
    sessionId: sessionId || undefined,
    candidateFirstName: names.candidateFirstName,
    candidateLastName: names.candidateLastName,
    candidateEntryPath: str(
      f.candidateEntryPath ??
        f.candidate_entry_path ??
        f.candidateLink ??
        f.candidate_link ??
        ""
    ),
    spectatorEntryPath: str(
      f.spectatorEntryPath ??
        f.spectator_entry_path ??
        f.spectatorLink ??
        f.spectator_link ??
        ""
    ),
    nullxesBusinessKey: coerceBusinessKey(str(f.nullxesBusinessKey ?? f.nullxes_business_key)),
    nullxesBusinessLabel: str(f.nullxesBusinessLabel ?? f.nullxes_business_label),
    companyName: str(f.companyName ?? f.company_name ?? ""),
    meetingAt: str(f.meetingAt ?? f.meeting_at ?? ""),
    jobAiStatus: coerceJobAiStatus(str(f.jobAiStatus ?? f.job_ai_status)),
    nullxesStatus: coerceNullxesStatus(str(f.nullxesStatus ?? f.nullxes_status)),
    updatedAt: str(f.updatedAt ?? f.updated_at ?? ""),
    statusChangedAt: str(f.statusChangedAt ?? f.status_changed_at ?? ""),
    createdAt: str(f.createdAt ?? f.created_at ?? ""),
    greetingSpeechResolved: str(f.greetingSpeechResolved ?? f.greeting_speech_resolved ?? ""),
    finalSpeechResolved: str(f.finalSpeechResolved ?? f.final_speech_resolved ?? "")
  };
}

export function normalizeInterviewListRows(rows: unknown[]): InterviewListRow[] {
  return rows.map((row) => normalizeInterviewListRow(row));
}
