// PROTOTYPE — one command (`pnpm dev`) serves:
//   /admin/*  the React SPA (variants A/B/C, switch with ?variant=)
//   /ssr/*    variant D, server-rendered by Hono JSX (no client JS)
//   /api/*    an in-memory mock of the public API (data resets on restart)
// The path layout mirrors ADR 0001 (single Worker, /admin and /api reserved).
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { getRequestListener } from '@hono/node-server';

function honoMock(): Plugin {
  return {
    name: 'furea-prototype-hono-mock',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req as { url?: string }).url ?? '/';
        if (!(url === '/' || url.startsWith('/api/') || url.startsWith('/ssr') || url.startsWith('/__proto'))) return next();
        const mod = await server.ssrLoadModule('/server/app.ts');
        return getRequestListener(mod.app.fetch)(req, res);
      });
    },
  };
}

export default defineConfig({
  base: '/admin/',
  plugins: [honoMock(), react()],
  server: { port: 5173 },
});
