import { credentialsFromEnv, signGetHeaders } from '../src/writers/sigv4';

describe('signGetHeaders', () => {
  // AWS's published SigV4 test-suite vector "get-vanilla" (GET / on example.amazonaws.com).
  // It pins the algorithm itself, independent of anything Neptune-specific.
  test('matches the AWS SigV4 test-suite known answer', async () => {
    const headers = await signGetHeaders({
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  test('Neptune: wss is signed as https for the neptune-db service, host carries the port', async () => {
    const headers = await signGetHeaders({
      url: 'wss://my-cluster.cluster-abc.us-east-1.neptune.amazonaws.com:8182/gremlin',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token-123' },
      now: new Date('2026-10-12T10:00:00Z'),
    });
    expect(headers.host).toBe('my-cluster.cluster-abc.us-east-1.neptune.amazonaws.com:8182');
    expect(headers['x-amz-date']).toBe('20261012T100000Z');
    expect(headers['x-amz-security-token']).toBe('token-123');
    expect(headers.authorization).toMatch(/Credential=AKIAEXAMPLE\/20261012\/us-east-1\/neptune-db\/aws4_request/);
    expect(headers.authorization).toMatch(/SignedHeaders=host;x-amz-date;x-amz-security-token/);
  });

  test('is deterministic for fixed inputs and changes with the time', async () => {
    const base = {
      url: 'wss://h.example:8182/gremlin',
      region: 'us-east-1',
      credentials: { accessKeyId: 'A', secretAccessKey: 'S' },
    };
    const t1 = await signGetHeaders({ ...base, now: new Date('2026-10-12T10:00:00Z') });
    const t1again = await signGetHeaders({ ...base, now: new Date('2026-10-12T10:00:00Z') });
    const t2 = await signGetHeaders({ ...base, now: new Date('2026-10-12T10:00:01Z') });
    expect(t1).toEqual(t1again);
    expect(t1.authorization).not.toBe(t2.authorization);
  });
});

describe('credentialsFromEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test('reads the Lambda environment variables', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIA1';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret1';
    process.env.AWS_SESSION_TOKEN = 'tok';
    await expect(credentialsFromEnv()).resolves.toEqual({ accessKeyId: 'AKIA1', secretAccessKey: 'secret1', sessionToken: 'tok' });
  });

  test('fails loudly when they are missing instead of signing with nothing', async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    await expect(credentialsFromEnv()).rejects.toThrow(/credentials are not available/);
  });
});
