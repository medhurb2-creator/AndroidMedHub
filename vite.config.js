// vite.config.js
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { glob } from 'glob';

export default defineConfig(() => {
  return {
    root: '.',
    publicDir: 'public',

    // Relative asset URLs — required for Capacitor and subpath deployments.
    base: './',

    // Treat .wasm as a first-class bundleable asset so `?url` imports resolve.
    assetsInclude: ['**/*.wasm'],

    // Worker must be an ES module to use `import ... from '...?url'`.
    worker: {
      format: 'es',
      rollupOptions: {
        output: {
          entryFileNames: 'scripts/workers/[name].js',
          chunkFileNames: 'scripts/workers/[name].js',
          assetFileNames: 'wasm/[name].[ext]'
        }
      }
    },

    build: {
      outDir: 'dist',
      target: 'esnext',

      rollupOptions: {
        input: Object.fromEntries(
          glob.sync(['index.html', 'pages/**/*.html']).map((file) => [
            file.replace(/\.html$/, '').replace(/\//g, '-'),
            resolve(__dirname, file),
          ])
        ),

        external: [
          /@myriaddreamin\/typst-ts-web-compiler\/.*\.test\./,
          /@myriaddreamin\/typst-ts-web-compiler\/.*\.spec\./,
        ],

        output: {
          entryFileNames: 'scripts/[name].js',
          chunkFileNames: 'scripts/[name].js',

          assetFileNames: (assetInfo) => {
            const name = assetInfo.name || '';
            if (name.endsWith('.css'))                          return 'css/[name].[ext]';
            if (name.endsWith('.wasm'))                         return 'wasm/[name].[ext]';
            if (/\.(ttf|otf|woff2?|eot)$/i.test(name))          return 'fonts/[name].[ext]';
            if (/\.(png|jpe?g|gif|svg|webp|avif|ico)$/i.test(name)) return 'images/[name].[ext]';
            return 'assets/[name].[ext]';
          },

          manualChunks(id) {
            if (id.includes('/scripts/pages/')) {
              const match = id.match(/\/scripts\/pages\/(.+)\.js$/);
              if (match) return `pages/${match[1]}`;
            }
            if (id.includes('/scripts/pdf-engine/')) {
              return 'pdf-engine';
            }
          },
        },
      },
    },

    server: {
      port: 3001,
      open: '/index.html',
    },
  };
});