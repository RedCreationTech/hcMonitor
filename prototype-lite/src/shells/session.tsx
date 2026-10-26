/* S-01 席位登录 + 登录态存储。分析侧终端（工作台 / 值守 / 分析壳手机 / 后台）共用一次登录，
 * 与真实产品一致：席位身份决定能进哪个终端、能按哪个按钮（服务端同样校验）。 */
import { createContext, useCallback, useContext, useMemo, useState, useEffect, type ReactNode } from 'react';
import { App, Button, Input, Segmented } from 'antd';
import { clearStream, useApi } from '../api/useStream';
import { mockMode } from '../shared/runtime';
import type { MemberRole } from '../shared/types';

export interface Actor {
  id: string;
  name: string;
  role: MemberRole;
  seat: string;
}

const KEY = 'yansin.actor';
const ROLE_LABEL: Record<MemberRole, string> = { reader: '报告阅读者', auditor: '审计员',  analyst: '分析师', reviewer: '复核人', collector: '采集员', admin: '管理员' };
const DEMO_ID: Record<MemberRole, string> = { reader: 'READ-01', auditor: 'AUD-01',  analyst: 'W-02', reviewer: 'R-01', collector: 'C-04', admin: 'A-01' };

interface Ctx {
  actor: Actor | null;
  signIn: (a: Actor) => void;
  signOut: () => void;
}

const ActorCtx = createContext<Ctx>({ actor: null, signIn: () => {}, signOut: () => {} });

export function ActorProvider({ children }: { children: ReactNode }) {
  const [actor, setActor] = useState<Actor | null>(null);
  const signIn = useCallback((a: Actor) => { localStorage.removeItem('yansin.logout-pending'); clearStream(); setActor(a); }, []);
  const signOut = useCallback(async () => {
    localStorage.setItem('yansin.logout-pending', '1');
    try { const r = await fetch('/v1/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (r.ok || r.status === 401) localStorage.removeItem('yansin.logout-pending'); } catch { /* Retry server revocation before the next explicit login. */ }
    finally { clearStream(); localStorage.removeItem(KEY); setActor(null); }
  }, []);
  useEffect(() => {
    let active = true;
    if (!localStorage.getItem('yansin.logout-pending')) void fetch('/v1/auth/me').then(async r => { if (r.ok && active) setActor((await r.json()).member); });
    const expired = () => { clearStream(); setActor(null); };
    window.addEventListener('auth-expired', expired);
    return () => { active = false; window.removeEventListener('auth-expired', expired); };
  }, []);

  const value = useMemo(() => ({ actor, signIn, signOut }), [actor, signIn, signOut]);
  return <ActorCtx.Provider value={value}>{children}</ActorCtx.Provider>;
}

export function useActor() {
  return useContext(ActorCtx);
}

export const roleLabel = (r: MemberRole) => ROLE_LABEL[r];

/** 登录页：既是 S-01 画面，也是分析侧终端的入口门 */
export function LoginScreen({ purpose }: { purpose: string }) {
  const { message } = App.useApp();
  const post = useApi();
  const { signIn } = useActor();
  const [role, setRole] = useState<MemberRole>('analyst');
  const [employee, setEmployee] = useState(DEMO_ID.analyst);
  const [pin, setPin] = useState('');

  const submit = async () => {
    try {
      if (localStorage.getItem('yansin.logout-pending')) await fetch('/v1/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const r = await post<{ ok: boolean; member: Actor }>('/auth/login', { employee, pin });
      signIn(r.member);
      message.success(`${r.member.name} 已登录 ${r.member.seat}`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="login-stage">
      <div className="login-card">
        <div className="login-brand">
          <b>「言心」MindDialogue</b>
          <span className="sub">局域网访谈证据工作台</span>
        </div>
        <div className="login-purpose">{purpose}</div>

        <Segmented
          block
          value={role}
          onChange={(v) => {
            setRole(v as MemberRole);
            setEmployee(DEMO_ID[v as MemberRole]);
          }}
          options={(Object.keys(ROLE_LABEL) as MemberRole[]).map((r) => ({ label: ROLE_LABEL[r], value: r }))}
        />

        <label className="login-field">
          <span>工号</span>
          <Input value={employee} onChange={(e) => setEmployee(e.target.value)} placeholder="W-02 / R-01 / C-04 / A-01" />
        </label>
        <label className="login-field">
          <span>口令</span>
          <Input.Password value={pin} onChange={(e) => setPin(e.target.value)} placeholder={mockMode ? "演示口令 1234（模拟服务）" : "请输入本地账号口令"} onPressEnter={submit} />
        </label>

        <Button type="primary" block disabled={!employee || pin.length < 4} onClick={submit}>
          登录工作台
        </Button>

        <ul className="login-hints">
          <li>分析师：导入、校正、分析和报告编制。</li>
          <li>复核人：审批 / 驳回 / 发布，驳回必须填写理由。</li>
          <li>管理员：任务分派、用途限制与审计；不自动拥有业务读取权。</li>
          <li>连续 3 次失败锁定 15min；登录、认领、处置、发布全部入审计流。</li>
        </ul>
      </div>
    </div>
  );
}
