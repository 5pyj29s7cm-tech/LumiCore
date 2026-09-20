import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import { createViteWatchIgnored } from './vite.watch-policy';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const target = env.LUMI_TARGET || (['desktop', 'mobile', 'all'].includes(mode) ? mode : 'desktop');
  const inputs: Record<string, string> = target === 'mobile'
    ? { mobile: 'index.mobile.html' }
    : target === 'all'
      ? { desktop: 'index.html', mobile: 'index.mobile.html' }
      : { desktop: 'index.html' };
  const outDir = target === 'all' ? 'dist' : `dist/${target}`;
  // Retired character assets must not ship or remain selectable in development.
  // Their working copies can be protected by the host's file-deletion policy.
  const retiredAvatar = (relative: string) => {
    const file = relative.replace(/\\/g, '/');
    return /^avatars\/(?:lumi-original|lumi-rigged|lumi-layered)(?:\/|$)/.test(file)
      || /^avatars\/lumi-reclining\/(?:seated-arm-v3|clean-plate-v[23]|smile-v2|thoughtful-v2)\.png$/.test(file);
  };

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'lumi-supported-public-assets',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            const relative = (request.url || '').split('?')[0].replace(/^\//, '');
            if (!retiredAvatar(relative)) return next();
            response.statusCode = 404; response.end();
          });
        },
        writeBundle() {
          const source = path.join(__dirname, 'public');
          fs.cpSync(source, path.join(__dirname, outDir), {
            recursive: true,
            filter: file => !retiredAvatar(path.relative(source, file)),
          });
        },
      },
      {
        name: 'lumi-platform-html-output',
        writeBundle() {
          const htmlName = target === 'mobile' ? 'index.mobile.html' : '';
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
      // Keep frontend source watching while excluding non-HMR runtime trees.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: {
        ignored: createViteWatchIgnored(__dirname),
      },
    },
    build: {
      outDir,
      copyPublicDir: false,
      // Picovoice ships as a single on-demand ESM bundle; keep warnings focused on truly unexpected growth.
      chunkSizeWarningLimit: 3500,
      rollupOptions: {
        input: inputs,
        output: {
          manualChunks(id: string) {
            const normalized = id.replace(/\\/g, '/');
            if (!normalized.includes('/node_modules/')) return;

            // Heavy feature libraries are intentionally left to the route-level
            // dynamic import graph. Forcing them into shared manual chunks makes
            // Rollup hoist preload helpers across chunk boundaries and can pull
            // 3D, MediaPipe, Picovoice, or terminal code into the desktop shell.
            if (normalized.includes('/node_modules/@tauri-apps/api/')) return 'vendor-tauri';
            if (normalized.includes('/node_modules/socket.io-client/') || normalized.includes('/node_modules/engine.io-client/')) return 'vendor-realtime';

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
