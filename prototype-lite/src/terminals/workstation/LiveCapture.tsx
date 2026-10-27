import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Space } from 'antd';
import { uploadResumable, useApi } from '../../api/useStream';
import { useActor } from '../../shells/session';
import { ConsentFields, participants } from './ConsentFields';

type Mark = { at: number; kind: string };
type Part = { aid: string; wall_start: number; wall_end?: number; wall_observed_until?: number; closed_by?: string; blob?: Blob };
type Saved = { key: string; owner_id: string; blob?: Blob; values: Record<string, unknown>; sid?: string; aid: string; timeline: Mark[]; parts?: Part[] };
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('minddialogue-capture', 1); r.onupgradeneeded = () => r.result.createObjectStore('captures', { keyPath: 'key' }); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function persist(saved?: Saved, remove?: string): Promise<Saved[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('captures', 'readwrite'); const store = tx.objectStore('captures');
    if (saved) store.put(saved.parts && !saved.key.includes(':chunk:') ? { ...saved, parts: saved.parts.map(({ blob: _blob, ...p }) => p) } : saved);
    if (remove) store.delete(remove); const r = store.getAll();
    tx.oncomplete = () => { resolve(r.result); db.close(); }; tx.onerror = () => { reject(tx.error); db.close(); };
  });
}
export function LiveCapture({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { actor } = useActor(); const api = useApi(); const { message } = App.useApp(); const [form] = Form.useForm();
  const video = useRef<HTMLVideoElement>(null); const stream = useRef<MediaStream>(); const recorder = useRef<MediaRecorder>();
  const lease = useRef<string>(); const saved = useRef<Saved>(); const started = useRef(0); const persistChain = useRef(Promise.resolve());
  const partDone = useRef<Promise<void>>(Promise.resolve()); const stopReason = useRef('stop'); const finishing = useRef(false);
  const [recording, setRecording] = useState(false); const [paused, setPaused] = useState(false); const [transitioning, setTransitioning] = useState(false);
  const [busy, setBusy] = useState(false); const [pending, setPending] = useState<Saved>(); const [error, setError] = useState(''); const [seconds, setSeconds] = useState(0); const [level, setLevel] = useState(0); const [partCount, setPartCount] = useState(0);
  const audioContext = useRef<AudioContext>(); const animation = useRef(0); const elapsed = () => (performance.now() - started.current) / 1000;
  useEffect(() => {
    if (!open) return;
    void persist().then(items => {
      const meta = items.find(i => i.owner_id === actor?.id && !i.key.includes(':chunk:')); if (!meta) return;
      if (meta.parts) {
        const parts = meta.parts.map(p => ({ ...p, wall_end: p.wall_end ?? p.wall_observed_until, closed_by: p.closed_by ?? 'recovered', blob: new Blob(items.filter(i => i.key.startsWith(meta.key + ':chunk:' + p.aid + ':')).sort((a,b) => a.key.localeCompare(b.key)).map(i => i.blob!), { type: 'video/webm' }) }));
        setPending({ ...meta, parts });
      } else {
        const chunks = items.filter(i => i.key.startsWith(meta.key + ':chunk:')).sort((a,b) => a.key.localeCompare(b.key)).map(i => i.blob!);
        setPending({ ...meta, blob: meta.blob ?? new Blob(chunks, { type: 'video/webm' }) });
      }
    }).catch(e => setError(String(e)));
  }, [open, actor?.id]);
  useEffect(() => {
    if (!recording) return;
    const clock = setInterval(() => setSeconds(Math.round(elapsed())), 500);
    const renewal = setInterval(() => { void api('/capture/lease', { lease_id: lease.current }).catch(() => { setError('采集控制租约失效，已停止；本地片段保留'); void finish('lease-lost'); }); }, 20000);
    return () => { clearInterval(clock); clearInterval(renewal); };
  }, [recording, api]);
  useEffect(() => () => { finishing.current = true; stopReason.current = 'recovered'; if (recorder.current?.state !== 'inactive') recorder.current?.stop(); stream.current?.getTracks().forEach(t => t.stop()); }, []);
  const release = async () => {
    finishing.current = true; cancelAnimationFrame(animation.current);
    const audio = audioContext.current; audioContext.current = undefined;
    const id = lease.current; lease.current = undefined;
    stream.current?.getTracks().forEach(t => t.stop()); stream.current = undefined;
    if (video.current) video.current.srcObject = null;
    // Browser audio shutdown must not block access to already saved media or retry controls.
    void audio?.close().catch(() => {});
    if (id) await fetch('/v1/capture/lease/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lease_id: id }), signal: AbortSignal.timeout(5000) }).catch(() => {});
  };
  const deliver = async (item: Saved) => {
    setBusy(true); setError(''); let current = item; let delivered = false;
    try {
      const allParts = item.parts ?? [{ aid: item.aid, blob: item.blob }];
      const parts = allParts.filter(p => p.blob?.size); const omitted = item.parts?.filter(p => !p.blob?.size) ?? [];
      if (!parts.length) throw new Error('没有可恢复媒体数据，请检查摄像头和麦克风');
      if (item.parts?.filter(p => p.blob?.size).some(p => !p.wall_end || !p.closed_by)) throw new Error('连续片段尚未完成保存');
      const files = parts.map(p => ({ aid: p.aid, file: new File([p.blob!], 'capture-' + p.aid + '.webm', { type: 'video/webm' }) }));
      if (!current.sid) {
        const capture = { clock: 'browser-monotonic', timeline: item.timeline, gaps: [...item.timeline.filter(t => t.kind === 'pause' || ['device-ended','recorder-error','lease-lost','storage-error','recovered'].includes(t.kind)), ...omitted.map(p => ({at:p.wall_start,kind:'empty-segment'}))], ...(item.parts ? { mode: 'independent-segments-v1', segments: item.parts.filter(p => p.blob?.size).map(p => ({ asset_id: p.aid, wall_start: p.wall_start, wall_end: p.wall_end, closed_by: p.closed_by })), omitted_segments: omitted.map(p => ({id:p.aid,wall_start:p.wall_start,reason:'未取得媒体数据，不作为分析素材'})) } : {}) };
        const s = await api<{ id: string }>('/sessions', { ...item.values, participants: participants(item.values), source: 'live', capture, assets: files.map(({ aid, file }) => ({ id: aid, name: file.name, size_bytes: file.size, duration_seconds: 0, kind: 'video' })), primary_asset_id: files[0].aid });
        current = { ...item, sid: s.id }; await persist(current); setPending(current);
      }
      for (const { aid, file } of files) await uploadResumable(current.sid!, aid, file);
      await api(`/sessions/${current.sid}/capture-complete`, { request_key: item.aid });
      const all = await persist(); for (const x of all.filter(x => x.key === item.key || x.key.startsWith(item.key + ':chunk:'))) await persist(undefined, x.key);
      delivered = true; if (omitted.length) message.warning(`${omitted.length}个空片段未取得媒体数据，已记录排除原因`); message.success('有效连续片段已封存并排队，暂停不进入分析窗口');
    } catch (e) { setPending(current); setError((e as Error).message + '；片段保留在此浏览器，可重试上传或下载原件'); }
    finally { await release(); setBusy(false); if (delivered) { setPending(undefined); saved.current = undefined; form.resetFields(); setPartCount(0); setSeconds(0); onClose(); } }
  };
  const closePart = async (kind: string) => {
    const rec = recorder.current; stopReason.current = kind;
    if (rec && rec.state !== 'inactive') rec.stop();
    await partDone.current;
  };
  const finish = async (kind = 'stop') => {
    if (finishing.current || !saved.current) return;
    finishing.current = true; setTransitioning(true);
    try {
      await closePart(kind); const item = saved.current;
      item.timeline.push({ at: elapsed(), kind }); setRecording(false); setPaused(false); setPending({ ...item, parts: item.parts?.map(p => ({ ...p })) });
      await persistChain.current; await persist(item);
      if (kind === 'stop') await deliver(item);
      else { setError('采集故障，已保存各片段；确认后可重试交付。仅故障尾段保持保守分析。'); await release(); }
    } catch (e) { setRecording(false); setPending(saved.current); setError('本地保存失败：' + String(e) + '；请下载已有原件'); await release(); }
    finally { setTransitioning(false); }
  };
  const beginPart = async (item: Saved, media: MediaStream) => {
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
    const rec = new MediaRecorder(media, { mimeType: mime }); recorder.current = rec; stopReason.current = 'recovered';
    const part: Part = { aid: 'AS-' + crypto.randomUUID().slice(0, 8), wall_start: elapsed() }; item.parts!.push(part); setPartCount(item.parts!.length);
    const chunks: Blob[] = []; let resolve!: () => void; let reject!: (reason: unknown) => void;
    partDone.current = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    rec.ondataavailable = event => {
      if (!event.data.size) return;
      const index = chunks.length; chunks.push(event.data); part.wall_observed_until = elapsed();
      const row = { ...item, key: item.key + ':chunk:' + part.aid + ':' + String(index).padStart(8, '0'), parts: undefined, blob: event.data };
      persistChain.current = persistChain.current.then(async () => { await persist(row); await persist(item); });
      void persistChain.current.catch(() => { setError('本地存储不足，已停止；请下载已有原件'); void finish('storage-error'); });
    };
    rec.onstop = () => {
      part.wall_end = Math.max(elapsed(), part.wall_start + .001); part.closed_by = stopReason.current; part.blob = new Blob(chunks, { type: mime });
      void persistChain.current.then(async () => { await persist(item); resolve(); }).catch(reject);
    };
    rec.onerror = () => { setError('录制故障，已保留片段'); void finish('recorder-error'); };
    try { await persist(item); rec.start(1000); }
    catch (e) {
      part.wall_end = elapsed(); part.closed_by = 'recorder-error'; part.blob = new Blob(chunks, { type: mime }); resolve();
      if (item.parts!.length === 1 && !chunks.length) { await persist(undefined, item.key).catch(() => {}); if (saved.current === item) saved.current = undefined; }
      throw e;
    }
  };
  const start = async () => {
    setTransitioning(true);
    try {
      const values = await form.validateFields(); setError(''); finishing.current = false; persistChain.current = Promise.resolve();
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前地址不支持安全采集，请使用本机 localhost 或局域网 HTTPS');
      const l = await api<{ id: string }>('/capture/lease', {}); lease.current = l.id;
      const media = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true }); stream.current = media;
      if (video.current) { video.current.srcObject = media; await video.current.play(); }
      const audio = new AudioContext(); audioContext.current = audio; const analyser = audio.createAnalyser(); analyser.fftSize = 256; audio.createMediaStreamSource(media).connect(analyser); const samples = new Uint8Array(analyser.frequencyBinCount);
      const meter = () => { analyser.getByteTimeDomainData(samples); setLevel(Math.max(...Array.from(samples, v => Math.abs(v - 128) / 128))); animation.current = requestAnimationFrame(meter); }; meter();
      started.current = performance.now(); const item: Saved = { owner_id: actor!.id, key: 'CAP-' + crypto.randomUUID(), aid: 'CAP-' + crypto.randomUUID().slice(0, 8), values, timeline: [{ at: 0, kind: 'start' }], parts: [] }; saved.current = item;
      media.getTracks().forEach(t => t.addEventListener('ended', () => { if (!finishing.current) void finish('device-ended'); }));
      await beginPart(item, media); setRecording(true); setPaused(false); setSeconds(0);
    } catch (e) { setError((e as Error).message); await release(); }
    finally { setTransitioning(false); }
  };
  const pause = async () => {
    if (!saved.current || !stream.current || transitioning) return;
    setTransitioning(true);
    try {
      if (paused) { await beginPart(saved.current, stream.current); saved.current.timeline.push({ at: elapsed(), kind: 'resume' }); }
      else { await closePart('pause'); saved.current.timeline.push({ at: elapsed(), kind: 'pause' }); }
      setPaused(!paused); await persist(saved.current);
    } catch (e) { setError(String(e)); void finish('storage-error'); }
    finally { setTransitioning(false); }
  };
  const download = (blob?: Blob, name = pending?.aid) => { if (!blob) return; const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name + '.webm'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); };
  return <Modal title="本机录制 · 录后自动分析" open={open} width={720} footer={null} maskClosable={false} closable={!recording && !busy && !transitioning} onCancel={onClose}>
    <Alert type="info" message="暂停会封存当前连续片段，恢复后另录一段。有效片段分别分析，不把暂停算作沉默，不跨缺口计算连续指标。每任务最多12段；短片段或故障尾段仍按各自质量降级。请勿清除未交付的本地录制。" />
    {error && <Alert type="error" message={error} />}
    {pending ? <Space wrap style={{ margin: 16 }}><Button loading={busy} onClick={() => deliver(pending)}>重试上传并分析</Button>{pending.parts ? pending.parts.map((p,i) => <Button key={p.aid} disabled={!p.blob?.size} onClick={() => download(p.blob,p.aid)}>{p.blob?.size ? `下载第${i+1}段原件` : `第${i+1}段未取得数据`}</Button>) : <Button onClick={() => download(pending.blob)}>下载本地原件</Button>}</Space> : <Form form={form} layout="vertical" disabled={recording || busy} initialValues={{ interviewer_id: 'P-INTERVIEWER', subject_id: 'P-SUBJECT' }}>
      <Form.Item name="subject_code" label="对象编号" rules={[{ required: true }]}><Input /></Form.Item><Form.Item label="场景" name="scene" rules={[{ required: true }]}><Input /></Form.Item><Form.Item label="告知文书编号" name="consent_doc" rules={[{ required: true }]}><Input /></Form.Item><ConsentFields />
    </Form>}
    <video aria-label="采集预览" ref={video} autoPlay muted playsInline style={{ width: '100%', maxHeight: 320, background: '#111' }} />
    <Space wrap style={{ marginTop: 12 }}><span>{recording ? paused ? '已暂停' : '正在录制' : '未录制'} · 已用 {seconds}s（含暂停） · {partCount}个连续片段</span><meter aria-label="麦克风电平" value={level} min={0} max={1} /><Button disabled={recording || busy || !!pending || transitioning} onClick={start}>开始录制</Button><Button disabled={!recording || transitioning || paused && partCount >= 12} onClick={pause}>{paused ? '恢复录制' : '暂停录制'}</Button><Button type="primary" disabled={!recording || busy || transitioning} onClick={() => finish()}>结束并分析</Button></Space>
  </Modal>;
}
