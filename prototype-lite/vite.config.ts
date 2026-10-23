import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mockServer } from './mock/plugin';

export default defineConfig({
  plugins: [mockServer(), react()],
  server: { port: 5185, host: '127.0.0.1' },
});
