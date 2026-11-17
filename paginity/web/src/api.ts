/** Accès à l'API de PAGINITY : jeton anti-falsification, messages d'erreur en français, confirmation d'identité. */

export class ApiError extends Error {
  constructor(public status: number, message: string, public details: any) {
    super(message);
  }
}

let csrf = '';
export function setCsrf(token: string) {
  csrf = token;
}
function readCsrfCookie(): string {
  const m = /(?:^|;\s*)paginity_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : csrf;
}

type ConfirmHandler = () => Promise<boolean>;
let confirmHandler: ConfirmHandler | null = null;
export function onConfirmationRequired(h: ConfirmHandler) {
  confirmHandler = h;
}
type UnauthorizedHandler = () => void;
let unauthorized: UnauthorizedHandler | null = null;
export function onUnauthorized(h: UnauthorizedHandler) {
  unauthorized = h;
}

export async function api<T = any>(method: string, url: string, body?: unknown, opts: { raw?: boolean; retry?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-CSRF-Token': readCsrfCookie() };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Le serveur PAGINITY ne répond pas. Vérifiez votre connexion internet.', null);
  }
  if (opts.raw && res.ok) return res as unknown as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.erreur ?? `Erreur ${res.status}`, data?.details ?? null);
    if (res.status === 403 && err.details?.confirmation && confirmHandler && opts.retry !== false) {
      if (await confirmHandler()) return api<T>(method, url, body, { ...opts, retry: false });
    }
    if (res.status === 401 && unauthorized && !url.startsWith('/api/connexion') && url !== '/api/etat') unauthorized();
    throw err;
  }
  return data as T;
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>('POST', url, body);
export const put = <T = any>(url: string, body: unknown = {}) => api<T>('PUT', url, body);
export const patch = <T = any>(url: string, body: unknown = {}) => api<T>('PATCH', url, body);
export const del = <T = any>(url: string, payload?: unknown) => api<T>('DELETE', url, payload);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
