import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const target = env.LUMI_TARGET || (['desktop', 'web', 'mobile', 'all'].includes(mode) ? mode : 'desktop');
  const inputs: Record<string, string> = target === 'web'
    ? { web: 'index.web.html' }
    : target === 'mobile'
      ? { mobile: 'index.mobile.html' }
      : target === 'all'
        ? { desktop: 'index.html', web: 'index.web.html', mobile: 'index.mobile.html' }
        : { desktop: 'index.html' };
  const outDir = target === 'all' ? 'dist' : `dist/${target}`;

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'lumi-platform-html-output',
        writeBundle() {
          const htmlName = target === 'web'
            ? 'index.web.html'
            : target === 'mobile'
              ? 'index.mobile.html'
              : '';
          if (!htmlName) return;
          const source = path.join(__dirname, outDir, htmlName);
          const dest = path.join(__dirname, outDir, 'index.html');
          if (fs.existsSync(source)) {
            fs.copyFileSync(source, dest);
            fs.rmSync(source);
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      allowedHosts: ['lumiai.asia', '.lumiai.asia'],
      watch: {
        ignored: ['**/gpt-sovits-src/**', '**/data/voice_training/**', '**/*.db', '**/db.json', '**/.keys.json', '**/data/**', '**/server/mcp/config.json'],
      },
    },
    build: {
      outDir,
      // Picovoice ships as a single on-demand ESM bundle; keep warnings focused on truly unexpected growth.
      chunkSizeWarningLimit: 3500,
      rollupOptions: {
        input: inputs,
        output: {
          manualChunks(id: string) {
            const normalized = id.replace(/\\/g, '/');
            if (!normalized.includes('/node_modules/')) return;

            if (normalized.includes('/node_modules/@react-three/drei/')) return 'vendor-r3-drei';
            if (normalized.includes('/node_modules/@react-three/fiber/')) return 'vendor-r3-fiber';
            if (normalized.includes('/node_modules/@react-three/postprocessing/') || normalized.includes('/node_modules/postprocessing/')) return 'vendor-r3-postprocessing';
            if (normalized.includes('/node_modules/three/examples/')) return 'vendor-three-addons';
            if (normalized.includes('/node_modules/three/')) return 'vendor-three-core';

            if (normalized.includes('/node_modules/@picovoice/')) return 'vendor-picovoice';
            if (normalized.includes('/node_modules/@mediapipe/')) return 'vendor-mediapipe';
            if (normalized.includes('/node_modules/@xterm/')) return 'vendor-terminal';
            if (normalized.includes('/node_modules/@tauri-apps/api/')) return 'vendor-tauri';
            if (normalized.includes('/node_modules/socket.io-client/') || normalized.includes('/node_modules/engine.io-client/')) return 'vendor-realtime';

            if (
              normalized.includes('/node_modules/react-markdown/') ||
              normalized.includes('/node_modules/remark-') ||
              normalized.includes('/node_modules/rehype-') ||
              normalized.includes('/node_modules/highlight.js/') ||
              normalized.includes('/node_modules/micromark') ||
              normalized.includes('/node_modules/mdast-util') ||
              normalized.includes('/node_modules/hast-util') ||
              normalized.includes('/node_modules/unist-util') ||
              normalized.includes('/node_modules/vfile')
            ) return 'vendor-markdown';

            if (normalized.includes('/node_modules/lucide-react/')) return 'vendor-icons';
            if (normalized.includes('/node_modules/motion/')) return 'vendor-motion';
            if (normalized.includes('/node_modules/react/') || normalized.includes('/node_modules/react-dom/')) return 'vendor-react';
          },
        },
      },
    },
    optimizeDeps: {
      exclude: ['gpt-sovits-src'],
      entries: ['./src/**/*.{tsx,ts}'],
    },
  };
});
