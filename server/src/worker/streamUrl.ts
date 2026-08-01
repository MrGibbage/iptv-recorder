import type { providers } from "../db/schema.js";
import { resolveProviderConnection } from "./providerShape.js";

// Standard Xtream Codes "live" stream URL convention:
//   {baseUrl}/live/{username}/{password}/{channelId}.ts
// This is an assumption based on the common Xtream panel convention, not
// something verified against a real provider yet — some panels use a
// different extension (.m3u8) or path shape. Adjust here if a real
// provider doesn't match once one is available to test against.
//
// M3U providers have no such template: a playlist is a flat list of
// already-resolved stream URLs, not "base + credentials + id" the way
// Xtream is. There's nothing here for the recorder to build — iptv-scheduler
// resolves the channel against the playlist itself and hands back the
// entry's stream URL as channelId, so it's passed through unchanged (see
// PLAN.md "M3U provider support" — recorder stays dumb about channel/M3U
// data, same as it already is about EPG).
export function buildStreamUrl(provider: typeof providers.$inferSelect, channelId: string): string {
  const connection = resolveProviderConnection(provider);
  if (connection.type === "m3u") {
    return channelId;
  }
  const base = connection.baseUrl.replace(/\/+$/, "");
  return `${base}/live/${encodeURIComponent(connection.username)}/${encodeURIComponent(connection.password)}/${encodeURIComponent(channelId)}.ts`;
}
