import { useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, downloadFile } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { Provider, Recording, RecordingStatus } from "../api/types";

const STATUSES: RecordingStatus[] = ["scheduled", "recording", "completed", "failed", "cancelled"];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in local time, and
// gives back the same — no timezone suffix, so it round-trips through
// `new Date()` fine for this UI's purposes.
function toDatetimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ScheduleForm({ providers, onScheduled }: { providers: Provider[]; onScheduled: () => void }) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? 0);
  const [channelId, setChannelId] = useState("");
  const [startTime, setStartTime] = useState(() => toDatetimeLocal(new Date(Date.now() + 5 * 60_000)));
  const [endTime, setEndTime] = useState(() => toDatetimeLocal(new Date(Date.now() + 65 * 60_000)));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSaving(true);
    try {
      await api.post("/recordings", {
        providerId,
        channelId,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
      });
      setChannelId("");
      onScheduled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="form">
      <label>
        Provider
        <select value={providerId} onChange={(e) => setProviderId(Number(e.target.value))}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Channel ID
        <input value={channelId} onChange={(e) => setChannelId(e.target.value)} required />
      </label>
      <label>
        Start
        <input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
      </label>
      <label>
        End
        <input type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" disabled={saving || providers.length === 0}>
          {saving ? "Scheduling…" : "Schedule"}
        </button>
      </div>
    </form>
  );
}

export function Recordings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const providerFilter = searchParams.get("providerId") ?? "";
  const statusFilter = searchParams.get("status") ?? "";
  const ruleFilter = searchParams.get("recurringRuleId") ?? "";

  const { data: providers } = useAsync<Provider[]>(() => api.get("/providers"), []);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (providerFilter) params.set("providerId", providerFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (ruleFilter) params.set("recurringRuleId", ruleFilter);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }, [providerFilter, statusFilter, ruleFilter]);

  const {
    data: recordings,
    error,
    loading,
    refetch,
  } = useAsync<Recording[]>(() => api.get(`/recordings${query}`), [query]);

  const [showSchedule, setShowSchedule] = useState(false);
  const [rowError, setRowError] = useState<string>();

  const providerName = (id: number) => providers?.find((p) => p.id === id)?.name ?? `#${id}`;

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  }

  async function handleCancel(recording: Recording) {
    if (!confirm(`Cancel recording #${recording.id}?`)) return;
    setRowError(undefined);
    try {
      await api.delete(`/recordings/${recording.id}`);
      refetch();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleDownload(recording: Recording) {
    setRowError(undefined);
    try {
      await downloadFile(`/recordings/${recording.id}/file`, `${recording.channelId}-${recording.id}.mp4`);
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="page-content">
      <h1>Recordings</h1>

      <div className="filters">
        <label>
          Provider
          <select value={providerFilter} onChange={(e) => setFilter("providerId", e.target.value)}>
            <option value="">All</option>
            {providers?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={statusFilter} onChange={(e) => setFilter("status", e.target.value)}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {ruleFilter && (
          <button onClick={() => setFilter("recurringRuleId", "")}>Clear rule filter (#{ruleFilter})</button>
        )}
      </div>

      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}
      {rowError && <p className="error">{rowError}</p>}

      {recordings && recordings.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Provider</th>
              <th>Channel</th>
              <th>Start</th>
              <th>End</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {recordings.map((recording) => (
              <tr key={recording.id}>
                <td>{recording.id}</td>
                <td>{providerName(recording.providerId)}</td>
                <td>{recording.channelId}</td>
                <td>{formatDateTime(recording.startTime)}</td>
                <td>{formatDateTime(recording.endTime)}</td>
                <td>
                  <span className={`badge badge-${recording.status}`}>{recording.status}</span>
                  {recording.failureReason && <div className="hint">{recording.failureReason}</div>}
                </td>
                <td className="row-actions">
                  {(recording.status === "scheduled" || recording.status === "recording") && (
                    <button onClick={() => handleCancel(recording)}>Cancel</button>
                  )}
                  {recording.status === "completed" && recording.filePath && (
                    <button onClick={() => handleDownload(recording)}>Download</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {recordings && recordings.length === 0 && !loading && <p>No recordings match these filters.</p>}

      {showSchedule ? (
        <section className="card">
          <h2>Schedule a one-off recording</h2>
          {providers && providers.length > 0 ? (
            <ScheduleForm
              providers={providers}
              onScheduled={() => {
                setShowSchedule(false);
                refetch();
              }}
            />
          ) : (
            <p>Add a provider first.</p>
          )}
        </section>
      ) : (
        <button onClick={() => setShowSchedule(true)}>Schedule recording</button>
      )}
    </div>
  );
}
