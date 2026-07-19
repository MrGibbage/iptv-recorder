import { useEffect, useState } from "react";
import { clearStoredApiKey, getStoredApiKey, storeApiKey } from "../api/client";

export function useApiKey() {
  const [apiKey, setApiKeyState] = useState<string | null>(getStoredApiKey());

  useEffect(() => {
    const handler = () => setApiKeyState(getStoredApiKey());
    // "storage" fires in other tabs; "apikeychange" fires in this one
    // (storeApiKey/clearStoredApiKey dispatch it, including on a 401).
    window.addEventListener("storage", handler);
    window.addEventListener("apikeychange", handler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("apikeychange", handler);
    };
  }, []);

  return { apiKey, setApiKey: storeApiKey, clearApiKey: clearStoredApiKey };
}
