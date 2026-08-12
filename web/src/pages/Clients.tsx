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
// Shows a value alongside a "Copy" button, since selecting-and-copying the
// long apiKey (or the apiUrl, easy to fat-finger by hand) by hand is
// error-prone — one wrong or missing character and the client app can't
// connect at all.
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. non-HTTPS context) — the value is
      // still selectable text in the <code> element below as a fallback.
    }
  }

  return (
    <div className="copy-field">
      <p className="hint" style={{ margin: "0 0 4px" }}>
        {label}
      </p>
      <div className="copy-row">
        <code style={{ userSelect: "all" }}>{value}</code>
        <button type="button" onClick={handleCopy}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}

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
        QR code from the client app you're connecting. Pairing another app too — even on this same device? Come back
        and create a separate client for it rather than reusing this QR — see the note above.
      </p>
      <CopyField label="API URL" value={created.apiUrl} />
      <CopyField label="API key" value={created.apiKey} />
      {qrDataUrl && <img src={qrDataUrl} alt="QR code encoding this client's API URL and key" width={240} height={240} />}
      <div className="form-actions">
        <button onClick={onDismiss}>Done</button>
      </div>
    </section>
  );
}

const COMMENT_MAX_LENGTH = 20;

function CreateForm({ onCreated }: { onCreated: (created: ClientCreated) => void }) {
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSaving(true);
    try {
      const created = await api.post<ClientCreated>("/clients", {
        name: name.trim(),
        comment: comment.trim() || null,
      });
      setName("");
      setComment("");
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
      <label>
        Comment
        <input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={COMMENT_MAX_LENGTH}
          placeholder="e.g. Kitchen tablet"
        />
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
  const [showRevoked, setShowRevoked] = useState(false);

  const revokedCount = clients?.filter((c) => c.revokedAt).length ?? 0;
  const visibleClients = clients?.filter((c) => showRevoked || !c.revokedAt);

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
      <p className="hint">
        <strong>One key per client, always.</strong> A client is one app — not one device. If a single laptop or phone
        runs two of these apps (say, Lao and iptv-web-player), each app still gets its own client and its own QR
        code; never scan the same QR into two different apps, and never reuse one client's key for another.
      </p>
      <p className="hint">
        <strong>Want two clients to show the same recordings anyway?</strong> That's what profiles are for, not
        shared keys. Set both clients to use the same profile name when scheduling (see the Profiles page) — every
        client already sees every profile's recordings regardless of which key it's using, so matching profile names
        across clients is the correct, supported way to get a shared view. Each client keeps its own key either way,
        which also means losing or revoking one client never affects the others.
      </p>

      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}
      {rowError && <p className="error">{rowError}</p>}

      {clients && clients.length > 0 && (
        <label className="checkbox-label">
          <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
          Show revoked ({revokedCount})
        </label>
      )}

      {visibleClients && visibleClients.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Comment</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleClients.map((client) => (
              <tr key={client.id}>
                <td>{client.id}</td>
                <td>{client.name}</td>
                <td>{client.comment}</td>
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
      {clients && clients.length > 0 && visibleClients && visibleClients.length === 0 && (
        <p>All clients are revoked — check "Show revoked" above to see them.</p>
      )}

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
