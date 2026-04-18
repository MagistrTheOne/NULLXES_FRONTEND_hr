/**
 * Контекст интервью для старта сессии и построения инструкций агента (JobAI + UI).
 */
export type InterviewStartContext = {
  candidateFirstName?: string;
  candidateLastName?: string;
  candidateFullName?: string;
  jobTitle?: string;
  vacancyText?: string;
  companyName?: string;
  /** Название специальности из JobAI (specialty.name) */
  specialtyName?: string;
  greetingSpeech?: string;
  finalSpeech?: string;
  questions?: Array<{ text: string; order: number }>;
};
