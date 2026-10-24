import { useEffect, useRef, useState } from 'react';
import { App, Alert, Button, Form, Input, Modal } from 'antd';
import { uploadFile, useApi } from '../../api/useStream';
import type { AssetRef } from '../../shared/types';

/**
 * 活体采集弹窗：本机 getUserMedia 采一路音视频，录制为 webm 后走与文件导入
 * 完全相同的离线批分析链路（登记 → 上传 → analyze-offline）。
 * real 模式由 Python 服务接收文件字节；mock 模式无上传端点，仅登记元数据。
 */
export function LiveCapture({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const post = useApi();
  const [form] = Form.useForm();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const timerRef = useRef(0);
  /** 组件卸载 / 弹窗关闭时置位：此时触发 onstop 只做清理，不再起分析链 */
  const discardRef = useRef(false);
  /** 结束瞬间的计时秒数，供 onstop 闭包读取（避免 setState 时序问题） */
  const stopDurRef = useRef(0);
  /** 录制起点时间戳，计时的基准 */
  const startTsRef = useRef(0);
  /** 结束瞬间的表单值，onstop 闭包读取 */
  const stopValsRef = useRef<{ subject_code: string; scene: string; consent_doc: string } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);

  // 打开弹窗即取流 + 起电平动画；关闭 / 卸载时停掉所有 track 与定时器
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    discardRef.current = false;
    setError(null);
    setRecording(false);
    setSeconds(0);
    setLevel(0);
    setBusy(false);
    const boot = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720 },
          audio: { echoCancellation: true },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        // WebAudio 电平：AnalyserNode 读时域峰值，驱动 div 高度动画，不做任何上传
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
          setLevel(peak);
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        if (!cancelled) setError(`无法打开摄像头 / 麦克风：${(e as Error).message ?? String(e)}。请检查浏览器授权与设备连接。`);
      }
    };
    void boot();
    return () => {
      cancelled = true;
      discardRef.current = true;
      cancelAnimationFrame(rafRef.current);
      window.clearInterval(timerRef.current);
      // 正在录制时关弹窗：只收尾不上传
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
      recorderRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, [open]);

  const start = async () => {
    // 与新建会话同规则：文书号必填，空则前端拦截
    try {
      await form.validateFields();
    } catch {
      return;
    }
    const stream = streamRef.current;
    if (!stream) return;
    // 优先 vp8+opus，不支持则降级纯 webm 容器
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => void finish();
    recorderRef.current = rec;
    const t0 = Date.now();
    startTsRef.current = t0;
    rec.start(1000); // timeslice 1s：断链时最多损失最后 1 秒
    setSeconds(0);
    setRecording(true);
    timerRef.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 500);
  };

  const stopAndAnalyze = async () => {
    try {
      await form.validateFields();
    } catch {
      return;
    }
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') return;
    // 先记下时长与表单值再停：onstop 是异步回调，闭包里读不到此刻状态
    stopDurRef.current = Math.max(1, Math.round((Date.now() - startTsRef.current) / 1000));
    stopValsRef.current = form.getFieldsValue() as { subject_code: string; scene: string; consent_doc: string };
    setBusy(true);
    rec.stop();
  };

  /** recorder.onstop：Blob → File → 登记 → 上传 → 起批。全程在已校验的表单值上进行 */
  const finish = async () => {
    window.clearInterval(timerRef.current);
    setRecording(false);
    const blob = new Blob(chunksRef.current, { type: 'video/webm' });
    chunksRef.current = [];
    if (discardRef.current) return;
    const vals = stopValsRef.current;
    if (!vals) {
      setBusy(false);
      return;
    }
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `活体采集_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.webm`;
    const file = new File([blob], name, { type: 'video/webm' });
    const asset: AssetRef = {
      id: `video:${name}`,
      name,
      size_bytes: file.size,
      duration_seconds: stopDurRef.current,
      kind: 'video',
    };
    try {
      const s = await post<{ id: string }>('/sessions', {
        subject_code: vals.subject_code,
        scene: vals.scene,
        consent_doc: vals.consent_doc,
        form: 'B',
        source: 'imported',
        assets: [asset],
      });
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', 'video');
      fd.append('asset_id', asset.id);
      fd.append('client_duration', String(Math.round(seconds) || 0));
      try {
        await uploadFile(`/sessions/${s.id}/assets`, fd);
      } catch {
        message.warning('素材上传未成功（服务端未支持上传），仅登记元数据');
      }
      await post(`/sessions/${s.id}/analyze-offline`, {});
      message.success('已起批，进度见任务台');
      // 任务台列表由 WS state 广播自动刷新；这里只关弹窗
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  return (
    <Modal
      title="活体采集 · 本机录制"
      open={open}
      onCancel={busy ? undefined : onClose}
      footer={null}
      width={640}
      maskClosable={false}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Alert
          type="info"
          showIcon
          message="采集在本机完成，结束后自动进入与文件导入相同的离线批分析链路；报告口径标注「离线导入 · 非实时」。"
        />
        {error && <Alert type="error" showIcon message={error} />}
        <Form form={form} layout="vertical" initialValues={{ form: 'B' }}>
          <Form.Item name="subject_code" label="对象编号" rules={[{ required: true, message: '请填写对象编号' }]}>
            <Input placeholder="M-121" />
          </Form.Item>
          <Form.Item name="scene" label="场景 / 地点" rules={[{ required: true, message: '请填写场景' }]}>
            <Input placeholder="经侦询问 · 谈话室 03" />
          </Form.Item>
          <Form.Item name="consent_doc" label="授权文书编号" rules={[{ required: true, message: '缺少告知文书号不可创建会话（R1）' }]} extra="口头告知场景填写「口头告知 · 录音留证」">
            <Input placeholder="SQ-2026-121" />
          </Form.Item>
        </Form>
        <div className="row" style={{ gap: 10 }}>
          <div style={{ flex: 1, background: '#111', borderRadius: 6, overflow: 'hidden', aspectRatio: '16 / 9' }}>
            <video ref={videoRef} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
          {/* 音频电平条：AnalyserNode 时域峰值驱动 div 高度 */}
          <div style={{ width: 14, height: 'auto', minHeight: 120, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
            <div
              style={{
                width: 8,
                height: `${Math.max(4, Math.round(level * 100))}%`,
                maxHeight: 240,
                borderRadius: 4,
                background: level > 0.6 ? '#ff4d4f' : level > 0.25 ? '#faad14' : '#52c41a',
                transition: 'height 80ms linear',
              }}
            />
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {recording && <span style={{ color: '#cf1322', fontSize: 12 }}>● REC</span>}
          <span className="mono" style={{ fontSize: 13 }}>{mm}:{ss}</span>
          <span className="grow" />
          <Button onClick={start} disabled={!!error || recording || busy || !streamRef.current}>开始采集</Button>
          <Button type="primary" onClick={stopAndAnalyze} disabled={!recording || busy} loading={busy}>
            结束并分析
          </Button>
        </div>
      </div>
    </Modal>
  );
}
