import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Относительные пути — корректно под /api/studio/projects/:id/preview/ */
export default defineConfig({
  base: './',
  plugins: [react()],
});
