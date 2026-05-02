import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Локальная разработка студии: API на этом хосте. Чат против прода: `VITE_PROXY_API=https://ollama.site-al.ru` при `npm run dev`. */
const apiTarget = process.env.VITE_PROXY_API?.trim() || 'http://127.0.0.1:3011';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': {
        target: process.env.VITE_PROXY_V1?.trim() || 'https://ollama.site-al.ru',
        changeOrigin: true,
        secure: true,
      },
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        secure: apiTarget.startsWith('https'),
      },
      '/preview': {
        target: apiTarget,
        changeOrigin: true,
        secure: apiTarget.startsWith('https'),
      },
    },
  },
});
