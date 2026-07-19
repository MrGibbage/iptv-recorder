import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { Provider } from "../api/types";

interface ProviderFormValues {
  name: string;
  baseUrl: string;
  username: string;
  password: string;
  maxConcurrentStreams: string;
  enabled: boolean;
}

const emptyForm: ProviderFormValues = {
  name: "",
  baseUrl: "",
  username: "",
  password: "",
  maxConcurrentStreams: "1",
  enabled: true,
};

// Shared by "add provider" and "edit provider" — on edit, username/password
// are left blank and only sent if the admin actually types a new value
// (the API never returns credentials to redisplay, so there's nothing to
// prefill and blank must mean "leave unchanged", not "clear it").
function ProviderForm({
  initial,
  isEdit,
  onSubmit,
  onCancel,
}: {
  initial: ProviderFormValues;
  isEdit: boolean;
  onSubmit: (values: ProviderFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSaving(true);
    try {
      await onSubmit(values);
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
        <input value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} required />
      </label>
      <label>
        Xtream base URL
        <input
          value={values.baseUrl}
          onChange={(e) => setValues({ ...values, baseUrl: e.target.value })}
          placeholder="http://provider.example.com:8080"
          required
        />
      </label>
      <label>
        Username{isEdit && " (leave blank to keep current)"}
        <input value={values.username} onChange={(e) => setValues({ ...values, username: e.target.value })} />
      </label>
      <label>
        Password{isEdit && " (leave blank to keep current)"}
        <input
          type="password"
          value={values.password}
          onChange={(e) => setValues({ ...values, password: e.target.value })}
        />
      </label>
      <label>
        Max concurrent streams
        <input
          type="number"
          min={1}
          value={values.maxConcurrentStreams}
          onChange={(e) => setValues({ ...values, maxConcurrentStreams: e.target.value })}
          required
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={values.enabled}
          onChange={(e) => setValues({ ...values, enabled: e.target.checked })}
        />
        Enabled
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function Providers() {
  const { data: providers, error, loading, refetch } = useAsync<Provider[]>(() => api.get("/providers"), []);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<string>();

  async function handleCreate(values: ProviderFormValues) {
    await api.post("/providers", {
      name: values.name,
      baseUrl: values.baseUrl,
      username: values.username,
      password: values.password,
      maxConcurrentStreams: Number(values.maxConcurrentStreams),
      enabled: values.enabled,
    });
    setAdding(false);
    refetch();
  }

  async function handleUpdate(id: number, values: ProviderFormValues) {
    const body: Record<string, unknown> = {
      name: values.name,
      baseUrl: values.baseUrl,
      maxConcurrentStreams: Number(values.maxConcurrentStreams),
      enabled: values.enabled,
    };
    if (values.username.trim() !== "") body.username = values.username;
    if (values.password.trim() !== "") body.password = values.password;
    await api.put(`/providers/${id}`, body);
    setEditingId(null);
    refetch();
  }

  async function handleToggleEnabled(provider: Provider) {
    setRowError(undefined);
    try {
      await api.put(`/providers/${provider.id}`, { enabled: !provider.enabled });
      refetch();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleDelete(provider: Provider) {
    if (!confirm(`Delete provider "${provider.name}"?`)) return;
    setRowError(undefined);
    try {
      await api.delete(`/providers/${provider.id}`);
      refetch();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="page-content">
      <h1>Providers</h1>

      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}
      {rowError && <p className="error">{rowError}</p>}

      {providers && providers.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Base URL</th>
              <th>Max streams</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) =>
              editingId === provider.id ? (
                <tr key={provider.id}>
                  <td colSpan={5}>
                    <ProviderForm
                      isEdit
                      initial={{
                        name: provider.name,
                        baseUrl: provider.baseUrl,
                        username: "",
                        password: "",
                        maxConcurrentStreams: String(provider.maxConcurrentStreams),
                        enabled: provider.enabled,
                      }}
                      onSubmit={(values) => handleUpdate(provider.id, values)}
                      onCancel={() => setEditingId(null)}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={provider.id}>
                  <td>{provider.name}</td>
                  <td>{provider.baseUrl}</td>
                  <td>{provider.maxConcurrentStreams}</td>
                  <td>
                    <button onClick={() => handleToggleEnabled(provider)}>
                      {provider.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </td>
                  <td className="row-actions">
                    <button onClick={() => setEditingId(provider.id)}>Edit</button>
                    <button onClick={() => handleDelete(provider)}>Delete</button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}

      {providers && providers.length === 0 && !loading && <p>No providers configured yet.</p>}

      {adding ? (
        <section className="card">
          <h2>Add provider</h2>
          <ProviderForm isEdit={false} initial={emptyForm} onSubmit={handleCreate} onCancel={() => setAdding(false)} />
        </section>
      ) : (
        <button onClick={() => setAdding(true)}>Add provider</button>
      )}
    </div>
  );
}
