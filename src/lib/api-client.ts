"use client";
// Thin API client used by the SPA. All routes are relative (gateway-safe + Vercel-safe).

async function req<T = any>(
  method: string,
  path: string,
  body?: any,
  opts?: { signal?: AbortSignal }
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
    signal: opts?.signal,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed: ${res.status}`) as any;
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json as T;
}

export const api = {
  get: <T = any>(p: string, opts?: { signal?: AbortSignal }) => req<T>("GET", p, undefined, opts),
  post: <T = any>(p: string, body?: any) => req<T>("POST", p, body),
  patch: <T = any>(p: string, body?: any) => req<T>("PATCH", p, body),
};
