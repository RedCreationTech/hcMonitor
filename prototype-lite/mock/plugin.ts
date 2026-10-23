/* Vite 插件形态的最小 mock server：
 *   WS  /v1/analysis/stream?channel=field|workstation|wall|mobile-h5
 *   REST /v1/... 见 README 接口清单
 * 目的不是仿真后端，而是让 R7「现场壳不出结论」在演示时是真的成立——
 * 打开 DevTools → Network → WS，现场壳通道的帧里确实没有 confidence / attribution。 */
import type { Plugin } from 'vite';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { Engine, project } from './engine';
import type { AssetKind, Channel, DeploymentForm, ModalityKey, ModalityState } from '../src/shared/types';

const VALID = new Set<Channel>(['workstation', 'wall', 'mobile-h5', 'field']);

/** 错误码 → 机器可读标识，前端按 code 分支而不是按文案。
 *  409 的真实语义不止「抢单冲突」，所以兜底给 CONFLICT，具体含义由 engine 显式带 code。 */
const CODES: Record<number, string> = {
  400: 'MARKER_SCHEMA',
  401: 'AUTH_FAILED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_FAILED',
  500: 'INTERNAL',
};

export function mockServer(): Plugin {
  const engine = new Engine();
  const wss = new WebSocketServer({ noServer: true });

  return {
    name: 'minddialogue-mock-server',
    configureServer(server) {
      const httpServer = server.httpServer;
      if (!httpServer) return;

      httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        if (url.pathname !== '/v1/analysis/stream') return;
        const requested = url.searchParams.get('channel');
        // 非法 channel 不回落 workstation：那是权限最大的一路，静默兜底等于把"猜参数"变成提权入口
        if (requested !== null && !VALID.has(requested as Channel)) {
          socket.write('HTTP/1.1 400 Bad Request\r\nX-Channel: invalid\r\n\r\n');
          socket.destroy();
          return;
        }
        const use = (requested ?? 'workstation') as Channel;
        wss.handleUpgrade(req, socket, head, (ws) => {
          (ws as WebSocket & { __channel: Channel }).__channel = use;
          ws.on('close', () => ws.terminate());
          const snap = project({ event: 'state', ts: engine.state.clock, payload: engine.snapshot() }, use);
          if (snap) ws.send(JSON.stringify(snap));
        });
      });

      server.middlewares.use('/v1', async (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const send = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };
        const fail = (r: { error?: number; code?: string; message?: string; claimed_by?: string | null }) =>
          send(r.error ?? 500, {
            error: r.code ?? CODES[r.error ?? 0] ?? 'INTERNAL',
            message: r.message ?? '请求失败',
            ...('claimed_by' in r ? { claimed_by: r.claimed_by } : {}),
          });
        const body = async <T>() => (await readJson(req)) as T;
        const seg = (i: number) => path.split('/')[i];
        const actorOf = () => engine.state.viewer.person;

        /* ── 设备授权位（R8：壳是否加载由权限位决定，与设备型号无关） ───────── */
        if (method === 'GET' && path === '/device/entitlement') {
          const a = engine.state.admin;
          return send(200, {
            forms: a.form_d_enabled ? (['A', 'B', 'C', 'D'] as DeploymentForm[]) : (['A', 'B', 'C'] as DeploymentForm[]),
            field_view_enabled: engine.state.field_view_enabled,
            modality_whitelist_d: a.modality_whitelist_d,
            retention_days: a.retention_days,
            analyst: engine.state.viewer.person,
          });
        }

        /* ── 回放控制（原型辅助层，真实产品由事件源驱动） ─────────────────── */
        if (method === 'GET' && path === '/demo/state') return send(200, engine.snapshot());
        if (method === 'POST' && path === '/demo/start') { engine.start(); return send(200, { ok: true }); }
        if (method === 'POST' && path === '/demo/pause') { engine.stop(); return send(200, { ok: true }); }
        if (method === 'POST' && path === '/demo/reset') { engine.resetDemo(); return send(200, engine.snapshot()); }
        if (method === 'POST' && path === '/demo/speed') {
          const { speed } = await body<{ speed: number }>();
          engine.setSpeed(Number(speed) || 1);
          return send(200, { ok: true });
        }
        if (method === 'POST' && path === '/demo/form') {
          const { form } = await body<{ form: DeploymentForm }>();
          const r = engine.setForm(form);
          if ('error' in r && r.error) return fail(r);
          return send(200, engine.snapshot());
        }
        if (method === 'POST' && path === '/demo/field-view') {
          const { on } = await body<{ on: boolean }>();
          engine.toggleFieldView(Boolean(on));
          return send(200, engine.snapshot());
        }
        if (method === 'POST' && path === '/demo/network') {
          const { on } = await body<{ on: boolean }>();
          engine.setWeakNetwork(Boolean(on));
          return send(200, { ok: true });
        }
        if (method === 'POST' && path === '/demo/modality') {
          const { modality, state } = await body<{ modality: ModalityKey; state: ModalityState }>();
          if (engine.state.form === 'D' && !engine.state.admin.modality_whitelist_d.includes(modality) && state !== 'off')
            return send(403, { error: 'MODALITY_NOT_ALLOWED_IN_FORM_D', message: '形态 D 仅允许白名单模态' });
          engine.setModality(modality, state);
          return send(200, engine.snapshot());
        }

        /* ── 身份 ─────────────────────────────────────────────────────────── */
        if (method === 'POST' && path === '/auth/login') {
          const { employee, pin } = await body<{ employee: string; pin: string }>();
          const r = engine.login(employee ?? '', pin ?? '');
          if ('error' in r && r.error) return fail(r);
          return send(200, r);
        }
        if (method === 'POST' && path === '/auth/logout') {
          const { actor } = await body<{ actor: string }>();
          return send(200, engine.logout(actor || actorOf()));
        }
        if (method === 'POST' && path === '/field/auth') {
          const { pin } = await body<{ pin: string }>();
          const r = engine.authField(pin);
          if ('error' in r && r.error) return fail(r);
          return send(200, r);
        }
        if (method === 'POST' && path === '/field/purge') return send(200, engine.purgeField());

        /* ── 会话 ─────────────────────────────────────────────────────────── */
        if (method === 'GET' && path === '/sessions') return send(200, engine.state.sessions);
        /** 设备工单：现场壳只看到"派给本机的任务元数据"，看不到任何分析结果 */
        if (method === 'GET' && path === '/device/sessions')
          return send(
            200,
            engine.state.sessions
              .filter((s) => (s.status === 'draft' || s.status === 'live') && s.source !== 'imported')
              .map((s) => ({
                id: s.id, subject_code: s.subject_code, scene: s.scene, form: s.form,
                status: s.status, consent_doc: s.consent_doc, collector: s.collector,
              })),
          );
        if (method === 'POST' && path === '/sessions') {
          const r = engine.createSession(await body<{
            subject_code: string; scene: string; form: DeploymentForm; consent_doc: string;
            source?: 'live' | 'imported';
            asset?: { name: string; size_bytes: number; duration_seconds: number; kind: AssetKind };
            /** 多信号源：音视频为主，近红外 / 毫米波为可选扩展，登记后全部进入批分析 */
            assets?: Array<{ name: string; size_bytes: number; duration_seconds: number; kind: AssetKind }>;
          }>());
          if ('error' in r && r.error) return fail(r);
          return send(200, r.session);
        }
        if (method === 'POST' && /^\/sessions\/[^/]+\/open$/.test(path)) {
          const r = engine.openSession(seg(2));
          if ('error' in r && r.error) return fail(r);
          return send(200, r);
        }
        if (method === 'POST' && /\/sessions\/[^/]+\/markers$/.test(path)) {
          const raw = await body<Record<string, unknown>>();
          const keys = Object.keys(raw).sort().join(',');
          if (keys !== 'device_id,ts')
            return send(400, { error: 'MARKER_SCHEMA', message: `标记只接受 {ts, device_id}，收到 [${keys}]` });
          return send(200, engine.addMarker(String(raw.device_id ?? 'unknown')));
        }
        if (method === 'POST' && /\/sessions\/[^/]+\/escalation-request$/.test(path)) {
          const { reason_code } = await body<{ reason_code: string }>();
          return send(200, engine.requestCall(reason_code || 'need_human'));
        }
        if (method === 'POST' && /\/sessions\/[^/]+\/disposition$/.test(path)) {
          const { ticket_id, lamp_level, advice_text, note, actor } = await body<{
            ticket_id: string; lamp_level: 'green' | 'orange' | 'red'; advice_text: string; note: string; actor: string;
          }>();
          const r = engine.recordDisposition(ticket_id, lamp_level, advice_text ?? '', note ?? '', actor ?? actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r);
        }
        if (method === 'POST' && /\/sessions\/[^/]+\/stop$/.test(path)) return send(200, engine.endSession());
        /* 离线导入素材的批分析：与实时监看分道，实时侧对导入会话仍返回 409 IMPORT_NOT_WIRED */
        if (method === 'POST' && /\/sessions\/[^/]+\/analyze-offline$/.test(path)) {
          const r = engine.analyzeOffline(seg(2), actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r);
        }
        if (method === 'POST' && /\/sessions\/[^/]+\/analyze-offline\/csv$/.test(path)) {
          const r = engine.offlineCsv(seg(2), actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r);
        }

        /* ── 呼叫队列 ─────────────────────────────────────────────────────── */
        if (method === 'GET' && path === '/tasks') return send(200, engine.state.tickets);
        if (method === 'POST' && /^\/tasks\/[^/]+\/claim$/.test(path)) {
          const { claimer } = await body<{ claimer: string }>();
          const r = engine.claimTicket(seg(2), claimer || actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, { ok: true, latency_seconds: r.latency });
        }

        /* ── 报告审批流 ───────────────────────────────────────────────────── */
        if (method === 'GET' && path === '/reports') return send(200, engine.state.reports);
        if (method === 'POST' && /^\/reports\/[^/]+\/submit$/.test(path)) {
          const { reviewer } = await body<{ reviewer?: string }>();
          const r = engine.submitReport(seg(2), actorOf(), reviewer ?? null);
          if ('error' in r && r.error) return fail(r);
          return send(200, r.report);
        }
        if (method === 'POST' && /^\/reports\/[^/]+\/approve$/.test(path)) {
          const r = engine.approveReport(seg(2), actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r.report);
        }
        if (method === 'POST' && /^\/reports\/[^/]+\/reject$/.test(path)) {
          const { note } = await body<{ note: string }>();
          const r = engine.rejectReport(seg(2), actorOf(), note ?? '');
          if ('error' in r && r.error) return fail(r);
          return send(200, r.report);
        }
        if (method === 'POST' && /^\/reports\/[^/]+\/publish$/.test(path)) {
          const r = engine.publishReport(seg(2), actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r.report);
        }
        if (method === 'POST' && /^\/reports\/[^/]+\/section$/.test(path)) {
          const { key, text } = await body<{ key: string; text: string }>();
          const r = engine.editReportSection(seg(2), key, text ?? '', actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r.report);
        }

        if (method === 'POST' && /^\/reports\/[^/]+\/export$/.test(path)) {
          const { mode } = await body<{ mode?: 'file' | 'print' }>();
          const r = engine.exportReport(seg(2), actorOf(), mode === 'print' ? 'print' : 'file');
          if ('error' in r && r.error) return fail(r);
          return send(200, r);
        }

        /* ── 标注复核与回流 ───────────────────────────────────────────────── */
        if (method === 'GET' && path === '/annotations') return send(200, engine.state.annotations);
        if (method === 'POST' && /^\/annotations\/[^/]+\/decision$/.test(path)) {
          const patch = await body<{ status: 'confirmed' | 'false_positive'; human_label?: string; note?: string }>();
          const r = engine.decideAnnotation(seg(2), patch, actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r.annotation);
        }
        if (method === 'POST' && /^\/annotations\/[^/]+\/reflow$/.test(path)) {
          const r = engine.reflowAnnotation(seg(2), actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r);
        }

        /* ── 规则库 ───────────────────────────────────────────────────────── */
        if (method === 'GET' && path === '/rules') return send(200, engine.state.rules);
        if (method === 'POST' && /^\/rules\/[^/]+\/toggle$/.test(path)) {
          const { enabled } = await body<{ enabled: boolean }>();
          const r = engine.toggleRule(seg(2), Boolean(enabled), actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r.rule);
        }
        if (method === 'POST' && /^\/rules\/[^/]+$/.test(path)) {
          const patch = await body<{ weight?: number; threshold?: number; literature_ref?: string }>();
          const r = engine.updateRule(seg(2), patch, actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r.rule);
        }

        /* ── 成员 / 集成 / Admin 门控 / 审计 ─────────────────────────────── */
        if (method === 'GET' && path === '/members') return send(200, engine.state.members);
        if (method === 'POST' && path === '/members') {
          const r = engine.inviteMember(await body<{ name: string; role: 'analyst' | 'reviewer' | 'collector' | 'admin'; seat: string; forms: DeploymentForm[] }>());
          if ('error' in r && r.error) return fail(r);
          return send(200, r.member);
        }
        if (method === 'POST' && /^\/members\/[^/]+\/forms$/.test(path)) {
          const { forms } = await body<{ forms: DeploymentForm[] }>();
          const r = engine.setMemberForms(seg(2), forms ?? [], actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r.member);
        }
        if (method === 'GET' && path === '/integrations') return send(200, engine.state.integrations);
        if (method === 'POST' && /^\/integrations\/[^/]+\/test$/.test(path)) return send(200, engine.testIntegration(seg(2), actorOf()));
        if (method === 'POST' && /^\/integrations\/[^/]+\/status$/.test(path)) {
          const { status } = await body<{ status: 'ok' | 'degraded' | 'off' }>();
          const r = engine.setIntegration(seg(2), status, actorOf());
          if ('error' in r && r.error) return fail(r);
          return send(200, r.integration);
        }
        if (method === 'GET' && path === '/admin/flags') return send(200, engine.state.admin);
        if (method === 'POST' && path === '/admin/flags') {
          const patch = await body<Record<string, unknown>>();
          return send(200, engine.setFlags(patch as never, actorOf()));
        }
        if (method === 'GET' && path === '/audit') return send(200, engine.state.audit);
        if (method === 'GET' && path === '/audit/verify') return send(200, engine.verifyAudit());

        /* ── 数据台账（R6 导出留痕）────────────────────────────────────────── */
        if (method === 'GET' && path === '/admin/ledger') return send(200, engine.ledger());
        if (method === 'POST' && path === '/admin/ledger/export') {
          const { scope, actor } = await body<{ scope?: 'events' | 'rules'; actor?: string }>();
          const r = engine.exportLedger(actor || actorOf(), scope === 'rules' ? 'rules' : 'events');
          if ('error' in r && r.error) return fail(r);
          return send(200, r);
        }

        // 未匹配的 /v1 路径必须回 JSON：交给 Vite 会返回 200 + index.html，
        // 让"接口不存在"在评审终端里看起来像成功
        return send(404, { error: 'NOT_FOUND', message: `未知端点 ${method} /v1${path}` });
      });

      engine.subscribe((evt) => {
        wss.clients.forEach((ws) => {
          const channel = (ws as WebSocket & { __channel?: Channel }).__channel ?? 'workstation';
          const out = project(evt, channel);
          if (out) ws.send(JSON.stringify(out));
        });
      });
    },
  };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}
