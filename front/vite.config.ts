import { defineConfig } from 'vite'
import packageJson from './package.json'

export default defineConfig({
  define: {
    __INTEGRATION_VERSION__: JSON.stringify(packageJson.version),
    // 라이브러리 모드의 React 진입점도 브라우저에서 운영 분기로 고정한다.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: { entry: 'src/widget.tsx', name: 'NoriAiWidget', formats: ['iife'], fileName: () => 'widget.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
    sourcemap: false,
  },
})
