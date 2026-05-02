const BASE = import.meta.env.VITE_API_BASE ?? '';

export type OllamaHealthStatus = 'ok' | 'offline';

export async function fetchOllamaHealth(): Promise<OllamaHealthStatus> {
  try {
    const res = await fetch(`${BASE}/api/health/ollama`, {
      credentials: 'include',
    });
    if (!res.ok) return 'offline';
    const data = (await res.json()) as { status?: string };
    return data.status === 'ok' ? 'ok' : 'offline';
  } catch {
    return 'offline';
  }
}
