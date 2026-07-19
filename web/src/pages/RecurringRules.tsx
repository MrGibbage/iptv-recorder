import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { Provider, RecurringRule } from "../api/types";

// bit 0 = Monday .. bit 6 = Sunday (matches recurring_rules.daysOfWeek).
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function daysOfWeekToLabel(mask: number): string {
  const days = DAY_LABELS.filter((_, i) => (mask & (1 << i)) !== 0);
  return days.length > 0 ? days.join(", ") : "(none)";
}

function minuteOfDayToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeToMinuteOfDay(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function CreateForm({ providers, onCreated }: { providers: Provider[]; onCreated: () => void }) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? 0);
  const [channelId, setChannelId] = useState("");
  const [days, setDays] = useState<boolean[]>(new Array(7).fill(false));
  const [startTime, setStartTime] = useState("20:00");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [endDate, setEndDate] = useState("");
  const [maxOccurrences, setMaxOccurrences] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  function toggleDay(index: number) {
    const next = [...days];
    next[index] = !next[index];
    setDays(next);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const daysOfWeek = days.reduce((mask, checked, i) => (checked ? mask | (1 << i) : mask), 0);
    if (daysOfWeek === 0) {
      setError("select at least one day");
      return;
    }
    setSaving(true);
    try {
      await api.post("/recordings", {
        providerId,
        channelId,
        recurrence: {
          daysOfWeek,
          startMinuteOfDay: timeToMinuteOfDay(startTime),
          durationMinutes: Number(durationMinutes),
          ...(endDate ? { endDate: new Date(endDate).toISOString() } : {}),
          ...(maxOccurrences ? { maxOccurrences: Number(maxOccurrences) } : {}),
        },
      });
      setChannelId("");
      onCreated();
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
      <div className="day-picker">
        {DAY_LABELS.map((label, i) => (
          <label key={label} className="checkbox-label">
            <input type="checkbox" checked={days[i]} onChange={() => toggleDay(i)} />
            {label}
          </label>
        ))}
      </div>
      <label>
        Start time
        <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
      </label>
      <label>
        Duration (minutes)
        <input
          type="number"
          min={1}
          value={durationMinutes}
          onChange={(e) => setDurationMinutes(e.target.value)}
          required
        />
      </label>
      <label>
        End date (optional)
        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
      </label>
      <label>
        Max occurrences (optional)
        <input type="number" min={1} value={maxOccurrences} onChange={(e) => setMaxOccurrences(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" disabled={saving || providers.length === 0}>
          {saving ? "Creating…" : "Create rule"}
        </button>
      </div>
    </form>
  );
}

function SkipForm({ ruleId, onSkipped }: { ruleId: number; onSkipped: () => void }) {
  const [date, setDate] = useState("");
  const [error, setError] = useState<string>();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await api.post(`/recordings/recurring/${ruleId}/skip`, { date });
      setDate("");
      onSkipped();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="inline-form">
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      <button type="submit">Skip date</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

export function RecurringRules() {
  const { data: providers } = useAsync<Provider[]>(() => api.get("/providers"), []);
  const { data: rules, error, loading, refetch } = useAsync<RecurringRule[]>(() => api.get("/recordings/recurring"), []);
  const [showCreate, setShowCreate] = useState(false);
  const [skippingRuleId, setSkippingRuleId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<string>();

  const providerName = (id: number) => providers?.find((p) => p.id === id)?.name ?? `#${id}`;

  async function handleCancelRule(rule: RecurringRule) {
    if (!confirm(`Cancel recurring rule #${rule.id}? Future occurrences won't be generated.`)) return;
    setRowError(undefined);
    try {
      await api.delete(`/recordings/recurring/${rule.id}`);
      refetch();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="page-content">
      <h1>Recurring Rules</h1>

      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}
      {rowError && <p className="error">{rowError}</p>}

      {rules && rules.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Provider</th>
              <th>Channel</th>
              <th>Days</th>
              <th>Time</th>
              <th>Duration</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td>{rule.id}</td>
                <td>{providerName(rule.providerId)}</td>
                <td>{rule.channelId}</td>
                <td>{daysOfWeekToLabel(rule.daysOfWeek)}</td>
                <td>{minuteOfDayToTime(rule.startMinuteOfDay)}</td>
                <td>{rule.durationMinutes} min</td>
                <td>
                  <span className={`badge ${rule.cancelledAt ? "badge-cancelled" : "badge-scheduled"}`}>
                    {rule.cancelledAt ? "cancelled" : "active"}
                  </span>
                </td>
                <td className="row-actions">
                  <Link to={`/recordings?recurringRuleId=${rule.id}`}>Occurrences</Link>
                  {!rule.cancelledAt && (
                    <>
                      <button onClick={() => setSkippingRuleId(skippingRuleId === rule.id ? null : rule.id)}>
                        Skip a date
                      </button>
                      <button onClick={() => handleCancelRule(rule)}>Cancel rule</button>
                    </>
                  )}
                  {skippingRuleId === rule.id && (
                    <SkipForm ruleId={rule.id} onSkipped={() => setSkippingRuleId(null)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {rules && rules.length === 0 && !loading && <p>No recurring rules yet.</p>}

      {showCreate ? (
        <section className="card">
          <h2>New recurring rule</h2>
          {providers && providers.length > 0 ? (
            <CreateForm
              providers={providers}
              onCreated={() => {
                setShowCreate(false);
                refetch();
              }}
            />
          ) : (
            <p>Add a provider first.</p>
          )}
        </section>
      ) : (
        <button onClick={() => setShowCreate(true)}>New recurring rule</button>
      )}
    </div>
  );
}
