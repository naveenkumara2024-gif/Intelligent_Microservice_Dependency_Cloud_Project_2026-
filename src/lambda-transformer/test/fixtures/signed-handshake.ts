// Run in a real Node process by gremlin-headers.test.ts (jest's VM cannot do the gremlin driver's
// dynamic import('ws')). Starts a WebSocket server, connects an IAM-signed GremlinWriter to it, and
// prints the handshake headers the server received as one JSON line.
import { WebSocketServer } from 'ws';
import { GremlinWriter } from '../../src/writers/gremlin';

const settle = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, ms))]);

// Read BEFORE the writer runs: connecting hides the global (that is the fix under test).
const globalWebSocketDefinedAtStart = typeof (globalThis as { WebSocket?: unknown }).WebSocket;

async function main(): Promise<void> {
  let seen: Record<string, unknown> | undefined;
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (info: { req: { headers: Record<string, unknown>; url: string } }, done: (ok: boolean) => void) => {
      seen = { ...info.req.headers, __url: info.req.url };
      done(true);
    },
  });
  server.on('connection', (socket: { close: () => void }) => socket.close());
  await new Promise<void>((resolve) => server.on('listening', () => resolve()));
  const port = server.address().port;

  const writer = new GremlinWriter({
    url: `ws://127.0.0.1:${port}/gremlin`,
    iamAuth: true,
    region: 'us-east-1',
    credentials: async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'tok-123' }),
  });
  const g = await writer.connectedSource();
  await settle(g.V().limit(1).toList(), 3000);
  await settle(writer.close(), 3000);
  server.close();

  console.log(
    JSON.stringify({
      globalWebSocketDefinedAtStart,
      port,
      headers: seen ?? null,
    }),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
