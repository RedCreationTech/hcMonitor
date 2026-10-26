import { sha256 } from '@noble/hashes/sha2.js';
import { useCallback, useEffect, useState } from 'react';
import type { Channel, DemoState, ServerEvent } from '../shared/types';

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new Event('auth-expired'));
    throw Object.assign(new Error(data.message ?? data.detail ?? res.statusText), { status: res.status, data });
  }
  if (body !== undefined) refresh();
  return data as T;
}
export function useApi() { return useCallback(api, []); }

let snapshot: DemoState | null = null;
let connected = false;
let frames = 0;
let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
export function refresh() { if (listeners.size) void fetch('/v1/state').then(async r => {
  if (r.status === 401) { window.dispatchEvent(new Event('auth-expired')); return; }
  if (r.ok) { snapshot = await r.json(); connected = true; notify(); }
}); }
export function clearStream() { snapshot = null; connected = false; socket?.close(); socket = null; clearTimeout(retry); notify(); }
function connect() {
  if (socket || !listeners.size) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/analysis/stream?channel=workstation`);
  socket = ws;
  ws.onopen = () => { connected = true; notify(); };
  ws.onmessage = m => {
    try {
      const event = JSON.parse(m.data) as ServerEvent;
      if (event.event === 'state') { snapshot = event.payload; frames++; notify(); }
    } catch { /* The next valid snapshot repairs a malformed frame. */ }
  };
  ws.onclose = event => {
    if (event.code === 4401 || event.code === 4403) { window.dispatchEvent(new Event('auth-expired')); return; }
    if (socket === ws) socket = null;
    connected = false; notify();
    if (listeners.size) retry = setTimeout(connect, 2000);
  };
}
export function useStream(_channel: Channel) {
  const [, render] = useState(0);
  useEffect(() => {
    const update = () => render(n => n + 1);
    listeners.add(update); connect(); refresh();
    const poll = setInterval(refresh, 5000);
    return () => { listeners.delete(update); clearInterval(poll); if (!listeners.size) { socket?.close(); socket = null; clearTimeout(retry); } };
  }, []);
  return { state: snapshot, connected, frames, events: [] as ServerEvent[] };
}

export async function uploadFile<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/v1${path}`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? data.detail ?? res.statusText);
  refresh(); return data as T;
}
const digest = async (data: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
export async function uploadResumable(sid: string, aid: string, file: File, progress?: (n: number) => void) {
  // Bounded chunks keep large files out of a single browser allocation. Server seals the whole-file hash.
  const full = sha256.create();
  for (let at = 0; at < file.size; at += 4 * 1024 * 1024) full.update(new Uint8Array(await file.slice(at, at + 4 * 1024 * 1024).arrayBuffer()));
  const sha = Array.from(full.digest(), b => b.toString(16).padStart(2, '0')).join('');
  const x = await api<{ id: string; bytes: number; status: string; sha256?: string }>(`/sessions/${sid}/assets/${aid}/upload`, { sha256: sha });
  if (x.status === 'complete') { if (x.sha256 !== sha) throw new Error('该素材已封存其他原件；不可覆盖'); return; }
  let offset = x.bytes;
  while (offset < file.size) {
    const bytes = await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer();
    const response = await fetch(`/v1/uploads/${x.id}`, { method: 'PUT', body: bytes,
      headers: { 'X-Upload-Offset': String(offset), 'X-Chunk-SHA256': await digest(bytes) } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? '上传分块失败；可重试续传');
    offset = data.bytes; progress?.(Math.round(offset / file.size * 100));
  }
  await api(`/uploads/${x.id}/complete`, {}); refresh();
}
