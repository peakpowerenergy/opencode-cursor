import { refreshCursorToken } from "./auth";
import {
  cursorModelsFromCloudItems,
  type CursorModel,
} from "./models";

function cloudApiUrl(): string {
  return (process.env.CURSOR_CLOUD_API_URL ?? "https://api.cursor.com").replace(
    /\/$/,
    "",
  );
}

function authorizationHeaders(apiKey: string, scheme: "bearer" | "basic") {
  const authorization =
    scheme === "bearer"
      ? `Bearer ${apiKey}`
      : `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  return {
    Accept: "application/json",
    Authorization: authorization,
  };
}

/**
 * Cloud Agents accepts either Bearer or Basic auth. Basic uses the API key
 * as the username and an empty password, which is the form documented at
 * https://cursor.com/docs/api.
 */
export async function cursorCloudFetch(
  path: string,
  apiKey: string,
): Promise<Response> {
  const url = `${cloudApiUrl()}${path}`;
  const bearer = await fetch(url, {
    headers: authorizationHeaders(apiKey, "bearer"),
  });
  if (bearer.status !== 401) return bearer;
  return fetch(url, { headers: authorizationHeaders(apiKey, "basic") });
}

export async function verifyCursorApiKey(apiKey: string): Promise<void> {
  const response = await cursorCloudFetch("/v1/me", apiKey);
  if (response.status === 401 || response.status === 403) {
    throw new Error("Cursor API key was rejected");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Cursor API key check failed: ${response.status}${detail ? ` ${detail}` : ""}`,
    );
  }
}

export async function listCursorCloudModels(
  apiKey: string,
): Promise<CursorModel[] | null> {
  try {
    const response = await cursorCloudFetch("/v1/models", apiKey);
    if (!response.ok) return null;
    const body = (await response.json()) as { items?: unknown };
    if (!Array.isArray(body.items)) return null;
    const items = body.items.filter(
      (item): item is { id?: string; displayName?: string } =>
        !!item && typeof item === "object",
    );
    const models = cursorModelsFromCloudItems(items).filter(
      (model) => model.id !== "auto",
    );
    if (models.length === 0) return null;
    return cursorModelsFromCloudItems(items);
  } catch {
    return null;
  }
}

export async function accessTokenForCursorApiKey(apiKey: string): Promise<string> {
  await verifyCursorApiKey(apiKey);
  try {
    const exchanged = await refreshCursorToken(apiKey);
    if (exchanged.access) return exchanged.access;
  } catch {
    // The proxy sends the dashboard key itself when exchange does not return a session token.
  }
  return apiKey;
}
