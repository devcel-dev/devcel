import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wyw from "@wyw-in-js/vite";
import path from "path";
import { bundledPluginVersions } from "./scripts/bundled-plugin-versions.mjs";
import { catalogChunks, catalogLocaleGroup } from "./scripts/catalog-chunks.mjs";

const host = process.env.TAURI_DEV_HOST;
const port = process.env.VITE_PORT ? parseInt(process.env.VITE_PORT) : 1420;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [
    bundledPluginVersions(import.meta.dirname),
    catalogChunks(import.meta.dirname),
    tailwindcss(),
    wyw({
      include: ["**/src/lib/react-data-grid/**/*.{ts,tsx}"],
    }),
    react(),
  ],

  resolve: {
    alias: [
      // The vendored grid package metadata points to its upstream build output.
      { find: /^@\/lib\/react-data-grid$/, replacement: path.resolve(import.meta.dirname, "./src/lib/react-data-grid/index.ts") },
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
    ],
  },
  
  // Optimization settings
  build: {
    // Fixed engine targets match the explicitly supported desktop WebViews.
    target: ["es2020", "edge111", "firefox128", "chrome111", "safari16.4"],
    cssTarget: ["edge111", "firefox128", "chrome111", "safari16.4"],
    // Increase chunk size warning limit
    chunkSizeWarningLimit: 2000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            catalogLocaleGroup,
            { name: 'vendor-react', test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/, priority: 40 },
            { name: 'vendor-ui', test: /[\\/]node_modules[\\/]@radix-ui[\\/]/, priority: 30 },
            { name: 'vendor-editor', test: /[\\/]node_modules[\\/](@tiptap[\\/]|tiptap-markdown[\\/])/, priority: 20 },
            { name: 'vendor-utils', test: /[\\/]node_modules[\\/](clsx|tailwind-merge|class-variance-authority)[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  
  // Pre-bundling optimization
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      'lucide-react',
    ],
    exclude: ['@tauri-apps/api', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-shell'],
  },
  
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
