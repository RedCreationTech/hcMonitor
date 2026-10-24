import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// mock 插件仅在 ANALYSIS_REAL 未开启时加载；real 模式下静态 import 也要能编译，所以保持顶层引入
import { mockServer } from './mock/plugin';

// ANALYSIS_REAL=1 → 真实 Python 分析服务（analysis-service/，默认 127.0.0.1:5190），REST 与 WS 全走 proxy
// 未设置 → mock 插件内置引擎，便于无服务环境回退演示
const real = process.env.ANALYSIS_REAL === '1';

export default defineConfig({
  plugins: real ? [react()] : [mockServer(), react()],
  server: {
    port: 5185,
    host: '127.0.0.1',
    ...(real ? { proxy: { '/v1': { target: 'http://127.0.0.1:5190', ws: true } } } : {}),
  },
});
