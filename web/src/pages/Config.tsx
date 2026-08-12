import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { ApiUrlConfig, RetentionConfig, StorageConfig } from "../api/types";

type TestStatus = "untested" | "testing" | "passed" | "failed";

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

// TODO8 (PLAN.md "Deployment") — the request-derived apiUrl that
// POST /clients hands new clients breaks down once a reverse proxy fronts
// a path-prefixed API rather than the API's own origin (found live during
// the 2026-08-02 Docker cutover: pairing through the real domain produced
// a portless URL that didn't actually reach the API). This section lets
// an operator override it, with a Test button to confirm a candidate
// value is actually reachable — against the unauthenticated GET /health,
// same as any other client would reach it — before trusting it.
function ApiUrlSection() {
  const { data, error, loading, refetch } = useAsync<ApiUrlConfig>(() => api.get("/config/api-url"), []);
  const [url, setUrl] = useState("");
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>("untested");
  const [testMessage, setTestMessage] = useState<string>();

  useEffect(() => {
    if (data) {
      setUrl(data.url ?? data.suggestedDefault);
    }
  }, [data]);

  function updateUrl(value: string) {
    setUrl(value);
    setTestStatus("untested");
    setTestMessage(undefined);
  }

  async function handleTest() {
    setTestStatus("testing");
    setTestMessage(undefined);
    try {
      // A plain cross-origin fetch, not api.get — this is testing whether
      // *some other device* could reach this exact URL directly, not
      // whether this browser's own /api-proxied origin works (it always
      // does, or nothing on this page would have loaded).
      const res = await fetch(`${url.replace(/\/+$/, "")}/health`);
      const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
      const body = isJson ? await res.json().catch(() => undefined) : undefined;
      if (res.ok && body?.status === "ok") {
        setTestStatus("passed");
      } else {
        setTestStatus("failed");
        // A 200 here doesn't necessarily mean this URL reaches the API —
        // e.g. it commonly means a reverse proxy served its own SPA
        // fallback page instead of proxying /health at all (verified live:
        // the default suggestion alone hits exactly this, since nginx only
        // proxies /api/*, not the bare root — that's the gap this whole
        // setting exists to let an operator work around).
        setTestMessage(
          res.ok && !isJson
            ? `Got HTTP ${res.status}, but not the API's response — this URL isn't reaching the API directly (likely hit something else, like the web UI's own page)`
            : `HTTP ${res.status}`,
        );
      }
    } catch (err) {
      setTestStatus("failed");
      setTestMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function save(value: string | null) {
    setSaveError(undefined);
    setSaving(true);
    try {
      await api.put("/config/api-url", { url: value });
      refetch();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p>Loading…</p>;
  if (error) return <p className="error">{error}</p>;

  const isOverridden = data?.url != null;

  return (
    <section className="card">
      <h2>Public API URL</h2>
      <p className="hint">
        Handed to newly paired clients (Lao, iptv-scheduler, iptv-web-player) as the address to reach this
        recorder's API — see the Clients page's QR code and Copy buttons. Auto-detected by default; override it if
        that doesn't match how clients should actually reach the API. If Test fails on the auto-detected value with a
        confusing "got HTTP 200 but..." message, that usually means it's this recorder's web address, not the API's —
        try this host's own IP and its API's published port instead (e.g. <code>http://&lt;this-host&gt;:3300</code>,
        matching <code>API_PORT</code> in <code>.env</code>).
      </p>
      {data && (
        <p className="hint">
          {isOverridden ? (
            <>
              Currently <strong>overridden</strong>. Auto-detected value right now: <code>{data.suggestedDefault}</code>
            </>
          ) : (
            <>
              Currently <strong>auto-detected</strong> — no override set.
            </>
          )}
        </p>
      )}
      <form onSubmit={(e) => { e.preventDefault(); save(url.trim() || null); }} className="form">
        <label>
          URL
          <input value={url} onChange={(e) => updateUrl(e.target.value)} placeholder={data?.suggestedDefault} required />
        </label>
        <div className="provider-test">
          <button type="button" onClick={handleTest} disabled={testStatus === "testing" || !url.trim()}>
            {testStatus === "testing" ? "Testing…" : "Test"}
          </button>
          {testStatus === "passed" && <span className="test-result test-result-ok">✓ Reachable</span>}
          {testStatus === "failed" && <span className="test-result test-result-fail">✗ {testMessage}</span>}
        </div>
        {saveError && <p className="error">{saveError}</p>}
        <div className="form-actions">
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {isOverridden && (
            <button type="button" onClick={() => save(null)} disabled={saving}>
              Reset to auto-detected
            </button>
          )}
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
      <ApiUrlSection />
    </div>
  );
}
