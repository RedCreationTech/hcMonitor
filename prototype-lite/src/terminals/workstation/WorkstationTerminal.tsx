import { Badge, Button, Layout, Menu } from 'antd';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { mockMode } from '../../shared/runtime';
import { useStream } from '../../api/useStream';
import { SessionsPage } from './SessionsPage';
import { GovernancePage } from './GovernancePage';
import { ReportsPage } from './ReportsPage';
import { OfflineResultPage } from './OfflineResultPage';
import { roleLabel, useActor } from '../../shells/session';
import { FORM_LABEL } from '../../../mock/script';

const { Sider, Content } = Layout;

/** 精简版分析工作台：素材上传分析 → 分析过程 → 分析结果 → 分析报告 */
export function WorkstationTerminal() {
  const { state } = useStream('workstation');
  const { actor, signOut } = useActor();
  const nav = useNavigate();
  const loc = useLocation();

  const pendingReview = state?.reports.filter((r) => r.status === 'pending_review').length ?? 0;
  const draftReports = state?.reports.filter((r) => r.status === 'drafting' || r.status === 'rejected').length ?? 0;
  const runningJobs = state?.sessions.filter((s) => !!s.offline_job).length ?? 0;

  const items = [
    { key: '/t/workstation', label: <Label text="任务台 · 素材分析" n={runningJobs} /> },
    { key: '/t/workstation/governance', label: '账号与项目治理' },
    { key: '/t/workstation/reports', label: <Label text="分析报告与审批" n={draftReports + pendingReview} /> },
  ];

  return (
    <div className="term">
      <div className="term-nav">
        <b>{mockMode ? '演示模式 · 脚本回放' : '访谈证据工作台 · M1'}</b>
        <span className="pill">{state ? FORM_LABEL[state.form] : '—'}</span>
        <span className="mono sub">录后批分析 · 证据校正 · 独立复核 · 版本授权</span>
        <span className="grow" />
        <span className="sub" style={{ fontSize: 12 }}>
          {actor ? `${actor.name}（${roleLabel(actor.role)}）· ${actor.seat}` : '未占席'} · channel=workstation
        </span>
      </div>
      <Layout className="term-body ws">
        <Sider
          width={188}
          theme="light"
          style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', overflow: 'auto' }}
        >
          <Menu
            mode="inline"
            selectedKeys={[mostSpecific(loc.pathname, items.map((i) => i.key))]}
            items={items}
            onClick={({ key }) => nav(key)}
            style={{ fontSize: 12.5, flex: 'none' }}
          />
          <div className="ws-sider-note">
            逐人授权后采集或导入，完整封存后分析。校正新建运行，复核与报告保留版本。
            本地叙述仅为候选；正式结论由指定专家作出。
          </div>
          <div className="ws-side-foot">
            <Button size="small" onClick={signOut}>退出占席</Button>
          </div>
        </Sider>
        <Content style={{ background: '#fff', minWidth: 0, overflow: 'auto' }}>
          <Routes>
            <Route index element={<SessionsPage />} />
            <Route path="offline/:id" element={<OfflineResultPage />} />
            <Route path="governance" element={<GovernancePage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="*" element={<Navigate to="/t/workstation" replace />} />
          </Routes>
        </Content>
      </Layout>
    </div>
  );
}

function Label({ text, n, danger }: { text: string; n: number; danger?: boolean }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="grow">{text}</span>
      {n > 0 && <Badge count={n} size="small" color={danger ? '#ff4d4f' : '#1664ff'} />}
    </span>
  );
}

/** 侧栏高亮：取匹配上的最长前缀，避免 /t/workstation 抢走所有子路由 */
function mostSpecific(pathname: string, keys: string[]) {
  const hit = keys
    .filter((k) => pathname === k || pathname.startsWith(`${k}/`))
    .sort((a, b) => b.length - a.length)[0];
  return hit ?? keys[0];
}
