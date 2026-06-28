import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/web/dashboard',
  build: {
    outDir: '../../../dist/web',
    emptyOutDir: true,
  },
});
