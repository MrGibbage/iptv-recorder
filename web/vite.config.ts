import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Reachable via Caddy/Cloudflare Tunnel at iptv-recorder.pelorus.org
    // (2026-08-01) — Vite's dev server rejects any Host header it doesn't
    // recognize by default (DNS-rebinding protection), which otherwise
    // shows up as a 403 from Vite itself, not from Caddy/the tunnel.
    allowedHosts: ['iptv-recorder.pelorus.org'],
    proxy: {
      '/api': {
        target: 'http://localhost:3300',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
