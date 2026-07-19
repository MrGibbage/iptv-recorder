import { decrypt } from "../crypto.js";
import type { providers } from "../db/schema.js";

// Standard Xtream Codes "live" stream URL convention:
//   {baseUrl}/live/{username}/{password}/{channelId}.ts
// This is an assumption based on the common Xtream panel convention, not
// something verified against a real provider yet — some panels use a
// different extension (.m3u8) or path shape. Adjust here if a real
// provider doesn't match once one is available to test against.
export function buildStreamUrl(provider: typeof providers.$inferSelect, channelId: string): string {
  const username = decrypt(provider.usernameEncrypted);
  const password = decrypt(provider.passwordEncrypted);
  const base = provider.baseUrl.replace(/\/+$/, "");
  return `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(channelId)}.ts`;
}
