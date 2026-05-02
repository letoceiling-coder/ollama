import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': {
        target: 'https://ollama.site-al.ru',
        changeOrigin: true,
        secure: true,
      },
      '/api': {
        target: 'https://ollama.site-al.ru',
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
