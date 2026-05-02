const BASE = import.meta.env.VITE_API_BASE ?? '';

export type OllamaHealthStatus = 'ok' | 'offline';

export type OllamaHealthResponse = {
  status: OllamaHealthStatus;
  /** На сервере заданы ключи облачных LLM — чат может работать без Ollama. */
  cloudFallbackConfigured: boolean;
};

export async function fetchOllamaHealth(): Promise<OllamaHealthResponse> {
  try {
    const res = await fetch(`${BASE}/api/health/ollama`, {
      credentials: 'include',
    });
    if (!res.ok) {
      return { status: 'offline', cloudFallbackConfigured: false };
    }
    const data = (await res.json()) as {
      status?: string;
      cloudFallbackConfigured?: boolean;
    };
    return {
      status: data.status === 'ok' ? 'ok' : 'offline',
      cloudFallbackConfigured: !!data.cloudFallbackConfigured,
    };
  } catch {
    return { status: 'offline', cloudFallbackConfigured: false };
  }
}
