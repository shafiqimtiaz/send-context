import { EncryptedPayload } from "./crypto.js";
import { workerBaseUrl } from "./link.js";

/** Upload an encrypted payload to the worker. Returns the stored record id. */
export async function uploadPayload(
  workerHost: string,
  payload: EncryptedPayload,
): Promise<string> {
  const res = await fetch(`${workerBaseUrl(workerHost)}/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const serverMsg = await readError(res);
    throw new Error(serverMsg ?? `Upload failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error("Worker did not return an id.");
  return data.id;
}

/** Download an encrypted payload by id. Throws LINK_EXPIRED on 404. */
export async function downloadPayload(
  workerHost: string,
  id: string,
): Promise<EncryptedPayload> {
  const res = await fetch(
    `${workerBaseUrl(workerHost)}/download/${encodeURIComponent(id)}`,
  );
  if (res.status === 404) {
    throw new Error("LINK_EXPIRED");
  }
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}).`);
  }
  return (await res.json()) as EncryptedPayload;
}

/** Best-effort extraction of a JSON `{error}` message from a failed response. */
async function readError(res: Response): Promise<string | null> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? null;
  } catch {
    return null;
  }
}
