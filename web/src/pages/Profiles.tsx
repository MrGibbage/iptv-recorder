import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { Profile } from "../api/types";

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSaving(true);
    try {
      await api.post("/profiles", { name: name.trim() });
      setName("");
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
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" disabled={saving || name.trim().length === 0}>
          {saving ? "Adding…" : "Add profile"}
        </button>
      </div>
    </form>
  );
}

export function Profiles() {
  const { data: profiles, error, loading, refetch } = useAsync<Profile[]>(() => api.get("/profiles"), []);
  const [rowError, setRowError] = useState<string>();

  async function handleDelete(profile: Profile) {
    if (!confirm(`Delete profile "${profile.name}"?`)) return;
    setRowError(undefined);
    try {
      await api.delete(`/profiles/${profile.id}`);
      refetch();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <div className="page-content">
      <h1>Profiles</h1>
      <p className="hint">
        Netflix-profile-style attribution, not a security boundary — any connected client can still see and manage
        every profile's recordings. Just a label for whose recording something is.
      </p>

      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}
      {rowError && <p className="error">{rowError}</p>}

      {profiles && profiles.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => (
              <tr key={profile.id}>
                <td>{profile.id}</td>
                <td>{profile.name}</td>
                <td className="row-actions">
                  <button onClick={() => handleDelete(profile)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {profiles && profiles.length === 0 && !loading && <p>No profiles yet.</p>}

      <section className="card">
        <h2>New profile</h2>
        <CreateForm onCreated={refetch} />
      </section>
    </div>
  );
}
