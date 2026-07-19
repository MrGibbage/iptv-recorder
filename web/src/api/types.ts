// Hand-kept mirror of server/src/db/schema.ts response shapes — no shared
// package between web/ and server/ yet, so these are duplicated by hand.

export interface Provider {
  id: number;
  name: string;
  baseUrl: string;
  maxConcurrentStreams: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RecordingStatus = "scheduled" | "recording" | "completed" | "failed" | "cancelled";

export interface Recording {
  id: number;
  providerId: number;
  channelId: string;
  recurringRuleId: number | null;
  startTime: string;
  endTime: string;
  status: RecordingStatus;
  filePath: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringRule {
  id: number;
  providerId: number;
  channelId: string;
  daysOfWeek: number;
  startMinuteOfDay: number;
  durationMinutes: number;
  endDate: string | null;
  maxOccurrences: number | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StorageConfig {
  id: number;
  directory: string;
  minFreeBytes: number;
  updatedAt: string;
}

export interface RetentionConfig {
  id: number;
  ttlDays: number | null;
  updatedAt: string;
}
