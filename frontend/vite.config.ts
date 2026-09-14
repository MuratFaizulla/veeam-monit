import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Same-origin during development, so the session cookie just works.
      '/api': {
        target: process.env.VITE_BACKEND_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
