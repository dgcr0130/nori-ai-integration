import { defineConfig } from 'vite'
export default defineConfig({ define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: { outDir: 'build/host', lib: { entry: 'host.js', formats: ['iife'], name: 'CookieHost', fileName: () => 'host.js' } } })
