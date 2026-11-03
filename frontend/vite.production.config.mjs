import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  envDir: false, publicDir: false,
  define: {
    'import.meta.env.VITE_API_ROOT': JSON.stringify(''),
    'import.meta.env.VITE_BETA_SUPPORT_EMAIL': JSON.stringify('pu3163329117@gmail.com'),
    'import.meta.env.VITE_BUILD_VERSION': JSON.stringify('source-sync-20261101-r3'),
  },
  build: { outDir: 'dist', emptyOutDir: false, sourcemap: false, assetsInlineLimit: 100000 },
})
