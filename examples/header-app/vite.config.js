import { defineConfig } from 'vite'
export default defineConfig({ define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: { outDir: 'build/host', lib: { entry: 'host.js', formats: ['iife'], name: 'HeaderHost', fileName: () => 'host.js' } } })
