import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApiKey } from "../hooks/useApiKey";
import { useAsync } from "../hooks/useAsync";
import { api, ApiError } from "../api/client";
import type { ClientCreated, SetupStatus } from "../api/types";

// User-requested 2026-08-02, replacing the CLI-only bootstrap: shown
// instead of the "paste a key" form only while GET /setup-status reports
// needsSetup — i.e. only until the very first client anywhere is created.
// POST /clients allows this one unauthenticated call under that same
// condition (requireApiKeyUnlessFirstClient, server/src/auth.ts).
function FirstRunSetup({ onCreated }: { onCreated: (created: ClientCreated) => void }) {
  const [name, setName] = useState("admin");
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setCreating(true);
    try {
      const created = await api.post<ClientCreated>("/clients", { name: name.trim() });
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="card">
      <h2>Set up this recorder</h2>
      <p className="hint">
        No clients exist yet — this one-time setup creates the first one, for this browser. After that, every
        additional client (other devices, apps like Lao) gets issued from the Clients page, same as any other.
      </p>
      <form onSubmit={handleSubmit} className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="submit" disabled={creating || name.trim().length === 0}>
            {creating ? "Setting up…" : "Get started"}
          </button>
        </div>
      </form>
    </section>
  );
}

export function Settings() {
  const { apiKey, setApiKey, clearApiKey } = useApiKey();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const navigate = useNavigate();
  // Unauthenticated, so this is safe to fetch even before a key exists —
  // decides which of the two "not connected" screens below to show.
  const { data: setupStatus, loading: setupStatusLoading } = useAsync<SetupStatus>(() => api.get("/setup-status"), []);

  async function handleConnect(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setConnecting(true);
    const trimmed = input.trim();
    setApiKey(trimmed);
    try {
      // Cheapest authenticated call, just to confirm the key actually works
      // before sending the user off to a page that'll immediately 401.
      await api.get("/providers");
      navigate("/providers");
    } catch (err) {
      clearApiKey();
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  // Deliberately no navigate() here (unlike handleConnect above) — the
  // whole point of landing on Settings for first-run setup is that setup
  // happens right there and stays right there; setApiKey's re-render is
  // what flips this same page over to the "Connected" section below, with
  // no page jump in between.
  function handleFirstRunCreated(created: ClientCreated) {
    setApiKey(created.apiKey);
  }

  return (
    <div className="page-content">
      <h1>Settings</h1>

      {apiKey ? (
        <section className="card">
          <h2>Connected</h2>
          <p>An API key is stored in this browser.</p>
          <p className="hint">
            Nothing scheduled yet? Head to <Link to="/providers">Providers</Link> to add your IPTV account.
          </p>
          <button
            onClick={() => {
              clearApiKey();
              setInput("");
            }}
          >
            Disconnect
          </button>
        </section>
      ) : setupStatusLoading ? (
        <p>Loading…</p>
      ) : setupStatus?.needsSetup ? (
        <FirstRunSetup onCreated={handleFirstRunCreated} />
      ) : (
        <section className="card">
          <h2>Connect</h2>
          <p>
            This is an admin-issued key, not a login — the recorder has no self-registration. Get one issued from an
            existing client's Clients page, or on the server with:
          </p>
          <pre>docker compose exec server node dist/db/seed-client.js &lt;name&gt;</pre>
          <p>then paste it below.</p>
          <form onSubmit={handleConnect} className="form">
            <input
              type="password"
              placeholder="API key"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={connecting || input.trim().length === 0}>
              {connecting ? "Connecting…" : "Connect"}
            </button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      )}
    </div>
  );
}
