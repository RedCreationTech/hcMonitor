import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Space } from 'antd';
import { uploadResumable, useApi } from '../../api/useStream';
import { useActor } from '../../shells/session';
import { ConsentFields, participants } from './ConsentFields';

type Saved = { key: string; owner_id: string; blob?: Blob; values: Record<string, unknown>; sid?: string; aid: string; timeline: Array<{ at: number; kind: string }> };
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('minddialogue-capture', 1); r.onupgradeneeded = () => r.result.createObjectStore('captures', { keyPath: 'key' }); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function persist(saved?: Saved, remove?: string): Promise<Saved[]> {
  const db = await database();
  return new Promise((resolve, reject) => { const tx = db.transaction('captures', 'readwrite'); const store = tx.objectStore('captures'); if (saved) store.put(saved); if (remove) store.delete(remove); const r = store.getAll(); tx.oncomplete = () => { resolve(r.result); db.close(); }; tx.onerror = () => { reject(tx.error); db.close(); }; });
}
export function LiveCapture({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { actor } = useActor();
  const api = useApi(); const { message } = App.useApp(); const [form] = Form.useForm();
  const video = useRef<HTMLVideoElement>(null); const stream = useRef<MediaStream>(); const recorder = useRef<MediaRecorder>();
  const chunks = useRef<Blob[]>([]); const lease = useRef<string>(); const saved = useRef<Saved>(); const started = useRef(0); const persistChain = useRef(Promise.resolve());
  const [recording, setRecording] = useState(false); const [paused, setPaused] = useState(false); const [busy, setBusy] = useState(false); const [pending, setPending] = useState<Saved>(); const [error, setError] = useState(''); const [seconds, setSeconds] = useState(0); const [level, setLevel] = useState(0); const audioContext = useRef<AudioContext>(); const animation = useRef(0);
  useEffect(() => { if (open) void persist().then(items => { const meta = items.find(i => i.owner_id === actor?.id && !i.key.includes(':chunk:')); if (meta) { const parts = items.filter(i => i.key.startsWith(meta.key + ':chunk:')).sort((a, b) => a.key.localeCompare(b.key)).map(i => i.blob!); setPending({ ...meta, blob: meta.blob ?? new Blob(parts, { type: 'video/webm' }) }); } }).catch(e => setError(String(e))); }, [open]);
  useEffect(() => {
    if (!recording) return;
    const clock = setInterval(() => setSeconds(Math.round((performance.now() - started.current) / 1000)), 500);
    const t = setInterval(() => { void api('/capture/lease', { lease_id: lease.current }).catch(() => { setError('采集控制租约失效，已停止录制；本地片段保留'); recorder.current?.stop(); }); }, 20000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [recording, api]);
  useEffect(() => () => { if (recorder.current?.state !== 'inactive') recorder.current?.stop(); stream.current?.getTracks().forEach(t => t.stop()); }, []);
  const release = async () => { cancelAnimationFrame(animation.current); await audioContext.current?.close().catch(() => {}); audioContext.current = undefined; if (lease.current) await api('/capture/lease/release', { lease_id: lease.current }).catch(() => {}); lease.current = undefined; stream.current?.getTracks().forEach(t => t.stop()); };
  const deliver = async (item: Saved) => {
    setBusy(true); setError('');
    let current = item;
    try {
      if (!item.blob?.size) throw new Error('没有可恢复的录制数据');
      const name = 'capture-' + item.aid + '.webm'; const file = new File([item.blob], name, { type: 'video/webm' });
      if (!current.sid) {
        const s = await api<{ id: string }>('/sessions', { ...item.values, participants: participants(item.values), source: 'live', capture: { clock: 'browser-monotonic', timeline: item.timeline, gaps: item.timeline.filter(t => t.kind === 'pause' || t.kind === 'device-ended') }, assets: [{ id: item.aid, name, size_bytes: file.size, duration_seconds: 0, kind: 'video' }], primary_asset_id: item.aid });
        current = { ...item, sid: s.id }; await persist(current); setPending(current);
      }
      await uploadResumable(current.sid!, item.aid, file);
      await api(`/sessions/${current.sid}/capture-complete`, { request_key: item.aid });
      const all = await persist(); for (const x of all.filter(x => x.key === item.key || x.key.startsWith(item.key + ':chunk:'))) await persist(undefined, x.key);
      setPending(undefined); message.success('录制原件已封存并排队分析'); onClose();
    } catch (e) { setPending(current); setError((e as Error).message + '；录制保留在此浏览器，可重试上传或下载原件'); }
    finally { setBusy(false); await release(); }
  };
  const start = async () => {
    try {
      const values = await form.validateFields(); setError('');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前地址不支持安全采集，请使用本机 localhost 或局域网 HTTPS');
      const l = await api<{ id: string }>('/capture/lease', {}); lease.current = l.id;
      const media = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true }); stream.current = media;
      if (video.current) video.current.srcObject = media;
      const audio = new AudioContext(); audioContext.current = audio; const analyser = audio.createAnalyser(); analyser.fftSize = 256; audio.createMediaStreamSource(media).connect(analyser); const samples = new Uint8Array(analyser.frequencyBinCount);
      const meter = () => { analyser.getByteTimeDomainData(samples); setLevel(Math.max(...Array.from(samples, v => Math.abs(v - 128) / 128))); animation.current = requestAnimationFrame(meter); }; meter();
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
      const rec = new MediaRecorder(media, { mimeType: mime }); recorder.current = rec; chunks.current = []; started.current = performance.now();
      const item: Saved = { owner_id: actor!.id, key: 'CAP-' + crypto.randomUUID(), aid: 'AS-' + crypto.randomUUID().slice(0, 8), values, timeline: [{ at: 0, kind: 'start' }] }; saved.current = item; await persist(item);
      rec.ondataavailable = event => { if (event.data.size) { const index = chunks.current.length; chunks.current.push(event.data); persistChain.current = persistChain.current.then(async () => { await persist({ ...item, key: item.key + ':chunk:' + String(index).padStart(8, '0'), blob: event.data }); }).catch(() => { setError('本地存储空间不足，已停止；请下载已录制原件'); if (rec.state !== 'inactive') rec.stop(); }); } };
      rec.onstop = () => { setRecording(false); setPaused(false); media.getTracks().forEach(t => t.stop()); const complete = { ...item, blob: new Blob(chunks.current, { type: mime }), timeline: [...item.timeline, { at: (performance.now() - started.current) / 1000, kind: 'stop' }] }; setPending(complete); void persistChain.current.then(async () => { await persist(complete); if (complete.timeline.some(t => t.kind === 'device-ended')) { setError('设备断开后的录制已保存，请确认缺口后重试上传'); await release(); } else await deliver(complete); }).catch(e => setError('本地保存失败：'+String(e))); };
      media.getTracks().forEach(t => t.addEventListener('ended', () => { item.timeline.push({ at: (performance.now() - started.current) / 1000, kind: 'device-ended' }); setError('设备断开，已停止并保留本地录制'); if (rec.state !== 'inactive') rec.stop(); }));
      rec.onerror = () => { setError('录制故障，本地片段已保留'); if (rec.state !== 'inactive') rec.stop(); };
      rec.start(1000); setRecording(true); setSeconds(0);
    } catch (e) { setError((e as Error).message); await release(); }
  };
  const pause = () => { const r = recorder.current; if (!r || !saved.current) return; if (paused) r.resume(); else r.pause(); saved.current.timeline.push({ at: (performance.now() - started.current) / 1000, kind: paused ? 'resume' : 'pause' }); setPaused(!paused); };
  const download = () => { if (!pending?.blob) return; const u = URL.createObjectURL(pending.blob); const a = document.createElement('a'); a.href = u; a.download = pending.aid + '.webm'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); };
  return <Modal title="本机录制 · 录后自动分析" open={open} width={720} footer={null} maskClosable={false} closable={!recording && !busy} onCancel={onClose}>
    <Alert type="info" message="片段逐秒保存在此浏览器。存在暂停/设备故障时，当前仅转写与回看，连续指标弃权；需要完整指标请录制连续片段。请勿清除未交付的本地录制。" />
    {error && <Alert type="error" message={error} />}
    {pending ? <Space style={{ margin: 16 }}><Button loading={busy} onClick={() => deliver(pending)}>重试上传并分析</Button><Button onClick={download}>下载本地原件</Button></Space> : <Form form={form} layout="vertical" disabled={recording || busy} initialValues={{ interviewer_id: 'P-INTERVIEWER', subject_id: 'P-SUBJECT' }}>
      <Form.Item name="subject_code" label="对象编号" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="scene" label="场景" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="consent_doc" label="告知文书编号" rules={[{ required: true }]}><Input /></Form.Item><ConsentFields />
    </Form>}
    <video aria-label="采集预览" ref={video} autoPlay muted playsInline style={{ width: '100%', maxHeight: 320, background: '#111' }} />
    <Space style={{ marginTop: 12 }}><span>{recording ? paused ? '已暂停' : '正在录制' : '未录制'} · 已用 {seconds}s（含暂停）</span><meter aria-label="麦克风电平" value={level} min={0} max={1} /><Button disabled={recording || busy || !!pending} onClick={start}>开始录制</Button><Button disabled={!recording} onClick={pause}>{paused ? '恢复录制' : '暂停录制'}</Button><Button type="primary" disabled={!recording || busy} onClick={() => recorder.current?.stop()}>结束并分析</Button></Space>
  </Modal>;
}
