// Hand-kept mirror of server/src/db/schema.ts response shapes — no shared
// package between web/ and server/ yet, so these are duplicated by hand.

export type ProviderType = "xtream" | "m3u";

export interface Provider {
  id: number;
  name: string;
  type: ProviderType;
  // Xtream only — always null for type = "m3u" (playlistUrl/epgUrl are
  // credential-shaped like username/password, so like those they're never
  // returned by /providers; see GET /providers/{id}/connection for the one
  // deliberate exception).
  baseUrl: string | null;
  maxConcurrentStreams: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RecordingStatus = "scheduled" | "recording" | "completed" | "failed" | "cancelled";

export interface Profile {
  id: number;
  name: string;
  createdAt: string;
}

export interface Recording {
  id: number;
  providerId: number;
  profileId: number | null;
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
  profileId: number | null;
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

export interface ApiUrlConfig {
  id: number;
  url: string | null;
  suggestedDefault: string;
  updatedAt: string;
}

export interface Client {
  id: number;
  name: string;
  comment: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ClientCreated extends Client {
  apiKey: string;
  apiUrl: string;
}

export interface SetupStatus {
  needsSetup: boolean;
}

export interface AuthCheckResult {
  ok: boolean;
  error?: string;
  checkedAt: string;
}
