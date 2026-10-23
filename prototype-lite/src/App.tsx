import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Navigate, Route, Routes } from 'react-router-dom';
import { WorkstationTerminal } from './terminals/workstation/WorkstationTerminal';
import { ActorProvider, LoginScreen, useActor } from './shells/session';

export function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{ token: { colorPrimary: '#1664ff', borderRadius: 6, fontSize: 13 } }}
    >
      <AntApp className="app-root">
        <ActorProvider>
          <Shell />
        </ActorProvider>
      </AntApp>
    </ConfigProvider>
  );
}

/** 精简版外层壳：只保留分析工作台，席位登录后直接进入；不再有终端切换 rail，也不挂演示控制坞 */
function Shell() {
  const { actor } = useActor();

  if (!actor) {
    return (
      <div className="app">
        <LoginScreen purpose="进入分析工作台（精简版）" />
      </div>
    );
  }

  return (
    <div className="app">
      <main className="stage-area">
        <Routes>
          <Route path="/t/workstation/*" element={<WorkstationTerminal />} />
          <Route path="*" element={<Navigate to="/t/workstation" replace />} />
        </Routes>
      </main>
    </div>
  );
}
