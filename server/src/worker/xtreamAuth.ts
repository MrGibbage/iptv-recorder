import { decrypt } from "../crypto.js";
import { PROVIDER_STATUS_CHECK_TIMEOUT_MS } from "../config.js";
import type { providers } from "../db/schema.js";

export type AuthCheckResult = { ok: true } | { ok: false; error: string };

// Standard Xtream Codes "player API" auth/info endpoint:
//   {baseUrl}/player_api.php?username=...&password=...
// Same unverified-against-a-real-provider caveat as buildStreamUrl in
// ./streamUrl.ts — this is the common Xtream panel convention, adjust here
// if a real provider's shape differs once one is available to test against.
// A valid response is JSON with user_info.auth === 1; invalid credentials
// typically come back as auth: 0 rather than an HTTP error, so a 200 alone
// doesn't mean the credentials are good.
//
// Takes raw credentials, not a stored provider row, so it can back both
// GET /providers/{id}/status (decrypts first, see checkProviderAuth below)
// and POST /providers/test (tests credentials the admin just typed, before
// they're ever saved/encrypted — see routes/providers.ts).
export async function checkXtreamAuth(credentials: {
  baseUrl: string;
  username: string;
  password: string;
}): Promise<AuthCheckResult> {
  const base = credentials.baseUrl.replace(/\/+$/, "");
  const url = `${base}/player_api.php?username=${encodeURIComponent(credentials.username)}&password=${encodeURIComponent(credentials.password)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_STATUS_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `provider responded with HTTP ${response.status}` };
    }
    const body = (await response.json()) as { user_info?: { auth?: number | boolean } };
    if (body.user_info?.auth === 1 || body.user_info?.auth === true) {
      return { ok: true };
    }
    return { ok: false, error: "provider rejected credentials" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "timed out contacting provider" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "unknown error contacting provider" };
  } finally {
    clearTimeout(timeout);
  }
}

export function checkProviderAuth(provider: typeof providers.$inferSelect): Promise<AuthCheckResult> {
  return checkXtreamAuth({
    baseUrl: provider.baseUrl,
    username: decrypt(provider.usernameEncrypted),
    password: decrypt(provider.passwordEncrypted),
  });
}
