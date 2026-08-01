import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { api, ApiError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { Client, ClientCreated } from "../api/types";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

// Shown exactly once, right after POST /clients returns — the raw key is
// never recoverable afterward (server/src/routes/clients.ts), so this
// panel is the only chance a client app gets to scan/copy it. The QR
// payload is a plain JSON string, `{apiUrl, apiKey}` — the same two fields
// every consuming app's own connection form already collects by hand
// (iptv-scheduler's RecorderSettings, iptv-web-player's RecorderConnection,
// Lao's SettingsScreen), so a scanner on their end just needs to
// JSON.parse() the decoded text into those fields.
function CreatedReveal({ created, onDismiss }: { created: ClientCreated; onDismiss: () => void }) {
  const [qrDataUrl, setQrDataUrl] = useState<string>();

  useEffect(() => {
    QRCode.toDataURL(JSON.stringify({ apiUrl: created.apiUrl, apiKey: created.apiKey }), { width: 240 }).then(
      setQrDataUrl,
    );
  }, [created]);

  return (
    <section className="card">
      <h2>Client "{created.name}" created</h2>
      <p className="hint">
        This API key is shown exactly once — it cannot be recovered after you leave this page. Copy it, or scan the
        QR code from the client app you're connecting.
      </p>
      <p>
        <code style={{ userSelect: "all" }}>{created.apiKey}</code>
      </p>
      {qrDataUrl && <img src={qrDataUrl} alt="QR code encoding this client's API URL and key" width={240} height={240} />}
      <div className="form-actions">
        <button onClick={onDismiss}>Done</button>
      </div>
    </section>
  );
}

function CreateForm({ onCreated }: { onCreated: (created: ClientCreated) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSaving(true);
    try {
      const created = await api.post<ClientCreated>("/clients", { name: name.trim() });
      setName("");
      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="form">
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" disabled={saving || name.trim().length === 0}>
          {saving ? "Creating…" : "New client"}
        </button>
      </div>
    </form>
  );
}

export function Clients() {
  const { data: clients, error, loading, refetch } = useAsync<Client[]>(() => api.get("/clients"), []);
  const [created, setCreated] = useState<ClientCreated>();
  const [rowError, setRowError] = useState<string>();

  async function handleRevoke(client: Client) {
    if (!confirm(`Revoke client "${client.name}"? Its API key will stop working immediately.`)) return;
    setRowError(undefined);
    try {
      await api.delete(`/clients/${client.id}`);
      refetch();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="page-content">
      <h1>Clients</h1>
      <p className="hint">Apps that connect to this recorder (Lao, iptv-scheduler, iptv-web-player, …), each with its own API key.</p>

      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}
      {rowError && <p className="error">{rowError}</p>}

      {clients && clients.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.id}>
                <td>{client.id}</td>
                <td>{client.name}</td>
                <td>{formatDateTime(client.createdAt)}</td>
                <td>
                  <span className={`badge ${client.revokedAt ? "badge-cancelled" : "badge-scheduled"}`}>
                    {client.revokedAt ? "revoked" : "active"}
                  </span>
                </td>
                <td className="row-actions">{!client.revokedAt && <button onClick={() => handleRevoke(client)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {clients && clients.length === 0 && !loading && <p>No clients yet.</p>}

      {created ? (
        <CreatedReveal created={created} onDismiss={() => { setCreated(undefined); refetch(); }} />
      ) : (
        <section className="card">
          <h2>New client</h2>
          <CreateForm onCreated={setCreated} />
        </section>
      )}
    </div>
  );
}
