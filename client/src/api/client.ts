export const API_BASE = (import.meta.env.VITE_API_BASE as string) ?? "/api";

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    // TODO: consider central 401 handling (e.g., dispatch auth:changed or open login modal)
    throw new Error(msg || res.statusText);
  }
  return res.json();
}
