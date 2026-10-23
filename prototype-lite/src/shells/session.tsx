/* S-01 席位登录 + 登录态存储。分析侧终端（工作台 / 值守 / 分析壳手机 / 后台）共用一次登录，
 * 与真实产品一致：席位身份决定能进哪个终端、能按哪个按钮（服务端同样校验）。 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { App, Button, Input, Segmented } from 'antd';
import { useApi } from '../api/useStream';
import type { MemberRole } from '../shared/types';

export interface Actor {
  id: string;
  name: string;
  role: MemberRole;
  seat: string;
}

const KEY = 'yansin.actor';
const ROLE_LABEL: Record<MemberRole, string> = { analyst: '分析师', reviewer: '复核人', collector: '采集员', admin: '管理员' };
const DEMO_ID: Record<MemberRole, string> = { analyst: 'W-02', reviewer: 'R-01', collector: 'C-04', admin: 'A-01' };

interface Ctx {
  actor: Actor | null;
  signIn: (a: Actor) => void;
  signOut: () => void;
}

const ActorCtx = createContext<Ctx>({ actor: null, signIn: () => {}, signOut: () => {} });

export function ActorProvider({ children }: { children: ReactNode }) {
  const [actor, setActor] = useState<Actor | null>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as Actor) : null;
    } catch {
      return null;
    }
  });

  const signIn = useCallback((a: Actor) => {
    localStorage.setItem(KEY, JSON.stringify(a));
    setActor(a);
  }, []);

  const signOut = useCallback(() => {
    localStorage.removeItem(KEY);
    setActor(null);
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
      const r = await post<{ ok: boolean; member: Actor }>('/auth/login', { employee, pin });
      signIn(r.member);
      message.success(`${r.member.name} 已占用席位 ${r.member.seat}`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="login-stage">
      <div className="login-card">
        <div className="login-brand">
          <b>「言心」MindDialogue</b>
          <span className="sub">需求编号 7008111111 · 分析侧席位登录</span>
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
          <Input.Password value={pin} onChange={(e) => setPin(e.target.value)} placeholder="演示口令 1234" onPressEnter={submit} />
        </label>

        <Button type="primary" block disabled={!employee || pin.length < 4} onClick={submit}>
          登录并占用席位
        </Button>

        <ul className="login-hints">
          <li>分析师：监看、归因、标注、起草报告；不能审批自己的报告。</li>
          <li>复核人：审批 / 驳回 / 发布，驳回必须填写理由。</li>
          <li>管理员：形态门控、规则库、成员授权、集成、审计。</li>
          <li>连续 3 次失败锁定 15min；登录、认领、处置、发布全部入审计流。</li>
        </ul>
      </div>
    </div>
  );
}
