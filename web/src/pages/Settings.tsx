import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useApiKey } from "../hooks/useApiKey";
import { api, ApiError } from "../api/client";

export function Settings() {
  const { apiKey, setApiKey, clearApiKey } = useApiKey();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const navigate = useNavigate();

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

  return (
    <div className="page-content">
      <h1>Settings</h1>

      {apiKey ? (
        <section className="card">
          <h2>Connected</h2>
          <p>An API key is stored in this browser.</p>
          <button
            onClick={() => {
              clearApiKey();
              setInput("");
            }}
          >
            Disconnect
          </button>
        </section>
      ) : (
        <section className="card">
          <h2>Connect</h2>
          <p>
            This is an admin-issued key, not a login — the recorder has no self-registration. Generate one on the
            server with:
          </p>
          <pre>pnpm --filter server db:seed-client &lt;name&gt;</pre>
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
