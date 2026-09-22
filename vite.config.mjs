import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))

function manualChunks(id) {
  if (!id.includes('node_modules')) return undefined
  if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'vendor-react'
  if (id.includes('/@heroui/') || id.includes('/framer-motion/')) return 'vendor-ui'
  if (id.includes('/@codemirror/') || id.includes('/@lezer/')) return 'vendor-editor'
  if (id.includes('/@xyflow/')) return 'vendor-flow'
  if (id.includes('/react-markdown/') || id.includes('/remark-') || id.includes('/micromark') || id.includes('/mdast-')) return 'vendor-markdown'
  if (id.includes('/diff-match-patch/')) return 'vendor-diff'
  return 'vendor-misc'
}

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: { '@': path.resolve(root, './src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: { output: { manualChunks } },
  },
})
