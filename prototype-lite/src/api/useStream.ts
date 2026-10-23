import { useCallback, useEffect, useState } from 'react';
import type { Channel, DemoState, ServerEvent } from '../shared/types';

/** 订阅 WS。通道在连接时告知服务端，由服务端决定能收到哪些字段（R7）。 */
export function useStream(channel: Channel) {
  const [events, setEvents] = useState<ServerEvent[]>([]);
  const [state, setState] = useState<DemoState | null>(null);
  const [connected, setConnected] = useState(false);
  const [frames, setFrames] = useState(0);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/v1/analysis/stream?channel=${channel}`);
    let stale = false;
    ws.onopen = () => !stale && setConnected(true);
    ws.onclose = () => !stale && setConnected(false);
    ws.onmessage = (m) => {
      if (stale) return;
      const evt = JSON.parse(m.data) as ServerEvent;
      setFrames((n) => n + 1);
      if (evt.event === 'state') {
        setState(evt.payload);
      } else if (evt.event === 'partial_fusion') {
        // 融合帧是现场壳唯一的实时源（R7：帧内没有结论字段）
        setState((prev) => prev && { ...prev, clock: evt.ts, lamp: evt.lamp, advice: evt.advice, modality_health: evt.modality_health, buffer_seconds: evt.buffer_seconds });
      } else if (evt.event === 'field.marker') {
        setState((prev) => prev && { ...prev, markers: [...prev.markers, evt.ts] });
      } else if (evt.event === 'impact') {
        setState((prev) => prev && { ...prev, impacts: [...prev.impacts.filter((i) => i.topic_id !== evt.topic_id), evt] });
      }
      setEvents((prev) => [...prev.slice(-400), evt]);
    };
    return () => {
      stale = true;
      // StrictMode 会在连接建立前卸载，此时直接 close() 会打出「closed before established」
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else ws.addEventListener('open', () => ws.close());
    };
  }, [channel]);

  return { events, state, connected, frames };
}

export function useApi() {
  return useCallback(async <T,>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((data as { message?: string }).message ?? res.statusText), { status: res.status, data });
    return data as T;
  }, []);
}
