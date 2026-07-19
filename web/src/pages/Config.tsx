import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { RetentionConfig, StorageConfig } from "../api/types";

const GIB = 1024 * 1024 * 1024;

function StorageSection() {
  const { data, error, loading, refetch } = useAsync<StorageConfig>(() => api.get("/config/storage"), []);
  const [directory, setDirectory] = useState("");
  const [minFreeGib, setMinFreeGib] = useState("1");
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setDirectory(data.directory);
      setMinFreeGib(String(data.minFreeBytes / GIB));
    }
  }, [data]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaveError(undefined);
    setSaving(true);
    try {
      await api.put("/config/storage", {
        directory,
        minFreeBytes: Math.round(Number(minFreeGib) * GIB),
      });
      refetch();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p>Loading…</p>;
  if (error) return <p className="error">{error}</p>;

  return (
    <section className="card">
      <h2>Storage</h2>
      <p className="hint">Changing the directory only affects future recordings — existing files aren't moved.</p>
      <form onSubmit={handleSubmit} className="form">
        <label>
          Directory
          <input value={directory} onChange={(e) => setDirectory(e.target.value)} required />
        </label>
        <label>
          Minimum free space (GiB)
          <input
            type="number"
            min={0}
            step="0.1"
            value={minFreeGib}
            onChange={(e) => setMinFreeGib(e.target.value)}
            required
          />
        </label>
        <p className="hint">New recordings are rejected if free disk space drops below this.</p>
        {saveError && <p className="error">{saveError}</p>}
        <div className="form-actions">
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}

function RetentionSection() {
  const { data, error, loading, refetch } = useAsync<RetentionConfig>(() => api.get("/config/retention"), []);
  const [enabled, setEnabled] = useState(false);
  const [ttlDays, setTtlDays] = useState("30");
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setEnabled(data.ttlDays !== null);
      if (data.ttlDays !== null) setTtlDays(String(data.ttlDays));
    }
  }, [data]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaveError(undefined);
    setSaving(true);
    try {
      await api.put("/config/retention", { ttlDays: enabled ? Number(ttlDays) : null });
      refetch();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p>Loading…</p>;
  if (error) return <p className="error">{error}</p>;

  return (
    <section className="card">
      <h2>Retention</h2>
      <p className="hint">
        Disabled by default — nothing is ever deleted automatically until you turn this on. When it runs, a
        completed recording's file is deleted once it's older than the TTL; the recording's history stays visible.
      </p>
      <form onSubmit={handleSubmit} className="form">
        <label className="checkbox-label">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable retention
        </label>
        <label>
          Keep recordings for (days)
          <input
            type="number"
            min={1}
            value={ttlDays}
            onChange={(e) => setTtlDays(e.target.value)}
            disabled={!enabled}
            required={enabled}
          />
        </label>
        {saveError && <p className="error">{saveError}</p>}
        <div className="form-actions">
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}

export function Config() {
  return (
    <div className="page-content">
      <h1>Config</h1>
      <StorageSection />
      <RetentionSection />
    </div>
  );
}
