import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard runs on :5173 and forwards API and WebSocket traffic to the chat server on :3000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
