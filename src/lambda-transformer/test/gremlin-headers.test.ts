// Regression test for a bug that only a real Neptune could show (Stage 9b): on Node >= 22 the
// gremlin driver used the global WebSocket, which it constructs without options, so the SigV4
// headers never left the process and Neptune answered 403 ("non-101 status code").
//
// The check that matters runs in a real Node subprocess (fixtures/signed-handshake.ts, bundled
// with esbuild): jest's VM sandbox cannot perform the driver's dynamic import('ws').
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import gremlin from 'gremlin';
import { WebSocketServer } from 'ws';

const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
});

describe('IAM-signed GremlinWriter on a runtime that has a global WebSocket', () => {
  test('this runtime really has a global WebSocket (otherwise nothing here proves anything)', () => {
    expect(typeof originalWebSocket).toBe('function');
  });

  test('control: the bare driver drops custom headers on this runtime (why the workaround exists)', async () => {
    // If this ever fails, the upstream driver was fixed and useNodeWebSocketLibrary() can go.
    let received: Record<string, unknown> | undefined;
    const server = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: (info: { req: { headers: Record<string, unknown> } }, done: (ok: boolean) => void) => {
        received = info.req.headers;
        done(true);
      },
    });
    server.on('connection', (socket: { close: () => void }) => socket.close());
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const connection = new gremlin.driver.DriverRemoteConnection(`ws://127.0.0.1:${server.address().port}/gremlin`, {
      headers: { authorization: 'should-have-been-sent' },
    });
    try {
      await Promise.race([
        gremlin.process.AnonymousTraversalSource.traversal().withRemote(connection).V().limit(1).toList().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      expect(received).toBeDefined();
      expect(received!.authorization).toBeUndefined();
    } finally {
      await connection.close().catch(() => undefined);
      server.close();
    }
  });

  test('GremlinWriter(iamAuth) delivers the signed headers in the opening handshake', () => {
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'handshake-')), 'signed-handshake.js');
    buildSync({
      entryPoints: [path.join(__dirname, 'fixtures', 'signed-handshake.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      outfile,
      external: ['bufferutil', 'utf-8-validate'],
      logLevel: 'silent',
    });
    const run = spawnSync(process.execPath, [outfile], { encoding: 'utf8', timeout: 30_000 });
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split('\n');
    const result = JSON.parse(lines[lines.length - 1]);

    // the subprocess runtime also had the global WebSocket the bug needs
    expect(result.globalWebSocketDefinedAtStart).toBe('function');
    expect(result.headers).not.toBeNull();
    expect(result.headers.__url).toBe('/gremlin');
    expect(String(result.headers.authorization)).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/neptune-db\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
    expect(result.headers['x-amz-security-token']).toBe('tok-123');
    expect(result.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(result.headers.host).toBe(`127.0.0.1:${result.port}`);
  });
});
