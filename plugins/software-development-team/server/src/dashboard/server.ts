// SECURITY NOTE: This dashboard server is intended for local development use only.
// It binds to a random ephemeral port (port 0) on localhost and has no authentication.
// Do NOT expose this server to a network. If network access is ever needed,
// authentication and authorization must be added before deployment.
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { StateMachine } from '../state/machine.js';
import type { MessageBus } from '../bus/message-bus.js';
import type { MemoryStore } from '../memory/store.js';
import type { DashboardEvent, Message, RunState, MemoryEntry } from '../types.js';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startDashboard(
  sm: StateMachine,
  bus: MessageBus,
  memoryStore: MemoryStore,
): Promise<number> {
  const app = express();

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use(express.json());

  // Resolve public directory — works in both dev (src/) and prod (dist/) layouts
  const candidates = [
    join(__dirname, 'public'),                              // dev: src/dashboard/public (unbundled)
    join(__dirname, 'dashboard', 'public'),                 // prod: dist/dashboard/public (tsup bundles to dist/index.js)
    join(__dirname, '..', '..', 'src', 'dashboard', 'public'), // fallback: relative to server/ root
  ];
  const publicDir = candidates.find((p) => existsSync(p)) ?? candidates[0];
  logger.info('Dashboard', `Serving static files from: ${publicDir}`);
  app.use(express.static(publicDir));

  app.get('/api/memory', (_req, res) => {
    res.json(memoryStore.getAll());
  });

  app.get('/api/runs', (_req, res) => {
    res.json(sm.getAllRuns());
  });

  app.get('/api/runs/:runId/messages', (req, res) => {
    res.json(bus.getAllMessages(req.params.runId));
  });

  app.post('/api/guidance', (req, res) => {
    const { runId, body } = req.body;
    if (!runId || !body) {
      res.status(400).json({ error: 'runId and body required' });
      return;
    }
    try {
      bus.post({ runId, from: 'user', to: 'coordinator', type: 'guidance', body });
      res.json({ success: true });
    } catch (err) {
      logger.error('Dashboard', 'Failed to post guidance message', { error: String(err) });
      res.status(500).json({ error: 'Failed to post message' });
    }
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  function broadcast(event: DashboardEvent) {
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  const onMessage = (message: Message) => {
    broadcast({ type: 'new_message', message });
  };

  const onStateUpdate = (run: RunState) => {
    broadcast({ type: 'state_update', run });
  };

  const onEntryChange = (entry: MemoryEntry) => {
    broadcast({ type: 'memory_entry_update', entry });
  };

  bus.on('message', onMessage);
  sm.on('state_update', onStateUpdate);
  memoryStore.on('entry_change', onEntryChange);

  httpServer.once('close', () => {
    bus.off('message', onMessage);
    sm.off('state_update', onStateUpdate);
    memoryStore.off('entry_change', onEntryChange);
  });

  return new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, () => {
      httpServer.off('error', reject);
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      logger.info('Dashboard', `Listening on http://localhost:${port}`);
      resolve(port);
    });
  });
}
