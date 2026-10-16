import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { ParameterNotFound } from '@aws-sdk/client-ssm';
import { classify } from '../src/alerts/classify';
import {
  dispatch,
  dispatchRecords,
  notifyPagerDuty,
  notifySlack,
  parseAlert,
  setDeps,
  subjectOf,
} from '../src/alerts/handler';
import { postJson, WebhookError } from '../src/alerts/http';
import { SsmSecretSource } from '../src/alerts/secrets';
import { AlertEvent } from '../src/alerts/types';
import {
  FakePublisher,
  FakeSecrets,
  deps,
  incident,
  opened,
  resolvedRecord,
  snsEvent,
  streamRecord,
  updated,
} from './alert-helpers';

function alert(record: ReturnType<typeof opened>): AlertEvent {
  const result = classify(record);
  if (result.kind !== 'alert') throw new Error(result.reason);
  return result.event;
}

/** Collects what Slack / PagerDuty would receive, and answers with a chosen status. */
function stubServer(status: number, responseBody = 'ok') {
  const requests: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body });
      res.statusCode = status;
      res.end(responseBody);
    });
  });
  return new Promise<{ url: string; requests: typeof requests; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/services/T000/B000/SECRETTOKEN`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(String(line)));
});
afterEach(() => {
  jest.restoreAllMocks();
  setDeps(undefined);
});

describe('dispatch: stream records -> SNS', () => {
  test('publishes one message per qualifying record, with the contract body and attributes', async () => {
    const publisher = new FakePublisher();
    const res = await dispatchRecords({ Records: [opened()] }, deps({ publisher }));

    expect(res).toEqual({ batchItemFailures: [] });
    expect(publisher.published).toHaveLength(1);
    const [msg] = publisher.published;
    expect(msg.topicArn).toBe('arn:aws:sns:us-east-1:111122223333:rca-alerts');
    expect(msg.subject).toBe('[RCA] Incident opened: productcatalogservice');
    expect(msg.attributes).toEqual({
      event_type: 'incident.opened',
      severity: 'error',
      root_cause: 'productcatalogservice',
    });
    // What went to SNS is exactly what the notifiers will accept and what classify() produced.
    expect(parseAlert(msg.message)).toEqual(alert(opened()));
    expect(JSON.parse(msg.message)).toMatchObject({ schema_version: 1, event: 'incident.opened' });
  });

  test('a mixed batch publishes only the opens and resolves, in order', async () => {
    const publisher = new FakePublisher();
    const a = incident({ incident_id: 'a', root_cause: 'svc-a' });
    const b = incident({ incident_id: 'b', root_cause: 'svc-b' });
    const batch = [
      opened(a),
      updated(a), // OPEN -> OPEN: no alert
      streamRecord('REMOVE', { old: b }), // TTL: no alert
      opened(b),
      resolvedRecord(a),
    ];
    await dispatchRecords({ Records: batch }, deps({ publisher }));
    expect(publisher.published.map((p) => `${p.attributes.event_type}:${JSON.parse(p.message).incident.incident_id}`)).toEqual([
      'incident.opened:a',
      'incident.opened:b',
      'incident.resolved:a',
    ]);
  });

  test('a nothing-to-alert batch publishes nothing and says why', async () => {
    const publisher = new FakePublisher();
    await dispatchRecords({ Records: [updated(), updated()] }, deps({ publisher }));
    expect(publisher.published).toHaveLength(0);
    const summary = logs.find((l) => l.startsWith('alert.batch '))!;
    expect(JSON.parse(summary.slice('alert.batch '.length))).toMatchObject({
      records: 2,
      published: 0,
      ignored: { 'modify-not-resolution': 2 },
    });
  });

  test('a failed publish reports that record and stops, so order is preserved on retry', async () => {
    const publisher = new FakePublisher();
    publisher.failOn = { call: 2, error: new Error('Throttling: Rate exceeded') };
    const records = [opened(incident({ incident_id: 'a' })), opened(incident({ incident_id: 'b' })), opened(incident({ incident_id: 'c' }))];

    const res = await dispatchRecords({ Records: records }, deps({ publisher }));

    expect(publisher.published).toHaveLength(1); // only 'a'; 'c' was not attempted after b failed
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: records[1].dynamodb!.SequenceNumber }]);
    expect(logs.some((l) => l.startsWith('alert.publish_failed '))).toBe(true);
  });

  test('without a sequence number a failure fails the whole batch (thrown)', async () => {
    const publisher = new FakePublisher();
    publisher.failOn = { call: 1, error: new Error('boom') };
    const record = opened();
    delete record.dynamodb!.SequenceNumber;
    await expect(dispatchRecords({ Records: [record] }, deps({ publisher }))).rejects.toThrow('boom');
  });

  test('refuses to run without a topic', async () => {
    await expect(dispatchRecords({ Records: [opened()] }, deps({ topicArn: undefined }))).rejects.toThrow('TOPIC_ARN');
  });

  test('the SNS subject is printable ASCII and at most 100 characters', () => {
    const subject = subjectOf(alert(opened(incident({ root_cause: 'svc-é\n' + 'x'.repeat(200) }))));
    expect(subject).toHaveLength(100);
    expect(subject).toMatch(/^[\x20-\x7e]+…?$/);
  });

  test('the exported handler wires the cached dependencies', async () => {
    const publisher = new FakePublisher();
    setDeps(deps({ publisher }));
    const res = await dispatch({ Records: [opened()] });
    expect(res.batchItemFailures).toEqual([]);
    expect(publisher.published).toHaveLength(1);
  });
});

describe('notifiers', () => {
  test('Slack: unconfigured -> no HTTP call, the rendered message is logged', async () => {
    const secrets = new FakeSecrets();
    const fetchFn = jest.fn();
    await notifySlack(snsEvent(alert(opened())), deps({ secrets, fetchFn }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(secrets.reads).toEqual(['/rca/alerts/slack-webhook-url']);
    const line = logs.find((l) => l.startsWith('alert.skipped '))!;
    const fields = JSON.parse(line.slice('alert.skipped '.length));
    expect(fields).toMatchObject({ channel: 'slack', reason: 'not-configured', event: 'incident.opened' });
    expect(fields.rendered.blocks[0].type).toBe('header');
  });

  test('Slack: posts the Block Kit body to the configured webhook and expects 200', async () => {
    const server = await stubServer(200);
    try {
      const secrets = new FakeSecrets({ '/rca/alerts/slack-webhook-url': server.url });
      await notifySlack(snsEvent(alert(opened()), alert(resolvedRecord())), deps({ secrets }));

      expect(server.requests).toHaveLength(2);
      expect(server.requests[0].headers['content-type']).toBe('application/json');
      const body = JSON.parse(server.requests[0].body);
      expect(body.text).toContain('Incident opened');
      expect(body.blocks[0].type).toBe('header');
      expect(JSON.parse(server.requests[1].body).text).toContain('Incident resolved');
      expect(logs.filter((l) => l.startsWith('alert.sent '))).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  test('Slack: a rejected webhook throws (so retry and DLQ engage) and never leaks the URL', async () => {
    const server = await stubServer(404, 'no_service');
    try {
      const secrets = new FakeSecrets({ '/rca/alerts/slack-webhook-url': server.url });
      const err = (await notifySlack(snsEvent(alert(opened())), deps({ secrets })).catch((e) => e)) as Error;
      expect(err).toBeInstanceOf(WebhookError);
      expect(err.message).toBe('slack request failed with HTTP 404: no_service');
      expect(err.message).not.toContain('SECRETTOKEN');
      expect(logs.join('\n')).not.toContain('SECRETTOKEN');
    } finally {
      await server.close();
    }
  });

  test('PagerDuty: unconfigured -> skipped, and the logged body carries a placeholder, never a key', async () => {
    const fetchFn = jest.fn();
    await notifyPagerDuty(snsEvent(alert(opened())), deps({ fetchFn }));
    expect(fetchFn).not.toHaveBeenCalled();
    const line = logs.find((l) => l.startsWith('alert.skipped '))!;
    expect(line).toContain('<routing-key-not-set>');
    expect(JSON.parse(line.slice('alert.skipped '.length)).rendered.dedup_key).toBe(alert(opened()).incident.incident_id);
  });

  test('PagerDuty: sends trigger then resolve with the same dedup_key and expects 202', async () => {
    const server = await stubServer(202, '{"status":"success"}');
    try {
      const secrets = new FakeSecrets({ '/rca/alerts/pagerduty-routing-key': 'ROUTING-KEY' });
      const open = alert(opened());
      await notifyPagerDuty(snsEvent(open, alert(resolvedRecord())), deps({ secrets, pagerDutyUrl: server.url }));

      const [trigger, resolve] = server.requests.map((r) => JSON.parse(r.body));
      expect(trigger).toMatchObject({ routing_key: 'ROUTING-KEY', event_action: 'trigger', dedup_key: open.incident.incident_id });
      expect(resolve).toEqual({ routing_key: 'ROUTING-KEY', event_action: 'resolve', dedup_key: open.incident.incident_id });
      // The routing key is a credential: it must not appear in a log line.
      expect(logs.join('\n')).not.toContain('ROUTING-KEY');
    } finally {
      await server.close();
    }
  });

  test('PagerDuty: a 400 throws with the status and a short body', async () => {
    const server = await stubServer(400, '{"status":"invalid event","message":"Event object is invalid"}');
    try {
      const secrets = new FakeSecrets({ '/rca/alerts/pagerduty-routing-key': 'k' });
      await expect(notifyPagerDuty(snsEvent(alert(opened())), deps({ secrets, pagerDutyUrl: server.url }))).rejects.toThrow(
        /pagerduty request failed with HTTP 400/,
      );
    } finally {
      await server.close();
    }
  });

  test('a message that is not the v1 contract throws instead of being rendered', async () => {
    const bad = { Records: [{ Sns: { Message: JSON.stringify({ schema_version: 2, event: 'incident.opened' }) } }] };
    await expect(notifySlack(bad, deps())).rejects.toThrow('unsupported alert schema_version 2');
    await expect(notifyPagerDuty({ Records: [{ Sns: { Message: 'not json' } }] }, deps())).rejects.toThrow('not JSON');
    expect(() => parseAlert(JSON.stringify({ schema_version: 1, event: 'incident.opened', incident: {} }))).toThrow(
      'missing event or incident fields',
    );
  });
});

describe('postJson', () => {
  test('a network failure reports the error class, not the URL', async () => {
    const fetchFn = jest.fn().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED https://hooks.slack.com/services/SECRET'), { name: 'TypeError' }));
    const err = await postJson('https://hooks.slack.com/services/SECRET', {}, { channel: 'slack', okStatuses: [200], fetchFn }).catch((e) => e);
    expect(err).toBeInstanceOf(WebhookError);
    expect(err.message).toBe('slack request failed: TypeError');
    expect(err.message).not.toContain('SECRET');
  });

  test('a stalled endpoint times out', async () => {
    const fetchFn = jest.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))),
    );
    await expect(
      postJson('https://x', {}, { channel: 'pagerduty', okStatuses: [202], fetchFn: fetchFn as never, timeoutMs: 20 }),
    ).rejects.toThrow('pagerduty request failed: timeout');
  });
});

describe('SsmSecretSource', () => {
  const param = (value: string) => ({ Parameter: { Value: value } });

  test('reads decrypted, trims, and caches for the TTL', async () => {
    const send = jest.fn().mockResolvedValue(param(' https://hook \n'));
    let now = 1_000;
    const source = new SsmSecretSource({ send } as never, () => now);

    expect(await source.get('/p')).toBe('https://hook');
    expect(await source.get('/p')).toBe('https://hook');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({ Name: '/p', WithDecryption: true });

    now += 5 * 60_000 + 1;
    await source.get('/p');
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('a missing parameter is undefined, re-checked after 30 s so switching a channel on is quick', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(new ParameterNotFound({ message: 'nope', $metadata: {} }))
      .mockResolvedValueOnce(param('now-set'));
    let now = 0;
    const source = new SsmSecretSource({ send } as never, () => now);

    expect(await source.get('/p')).toBeUndefined();
    expect(await source.get('/p')).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);

    now += 31_000;
    expect(await source.get('/p')).toBe('now-set');
  });

  test('any other error (e.g. AccessDenied) is thrown, never mistaken for "not configured"', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }));
    await expect(new SsmSecretSource({ send } as never).get('/p')).rejects.toThrow('not authorized');
  });
});
