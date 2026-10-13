import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { cidrProblem, isWorldOpen, parseArgs } from '../scripts/storefront';

describe('cidrProblem', () => {
  test.each(['203.0.113.7/32', '10.0.0.0/8', '0.0.0.0/0', ' 198.51.100.0/24 '])('accepts %p', (c) => {
    expect(cidrProblem(c)).toBeUndefined();
  });

  test.each(['203.0.113.7', '300.1.1.1/32', '10.0.0.0/33', 'garbage', '::1/128', ''])('rejects %p', (c) => {
    expect(cidrProblem(c)).toBeDefined();
  });
});

describe('parseArgs', () => {
  test('defaults to open, not off', () => {
    expect(parseArgs([])).toEqual({ off: false, allow: [] });
  });

  test('--off', () => {
    expect(parseArgs(['--off'])).toEqual({ off: true, allow: [] });
  });

  test('--allow takes a comma list', () => {
    expect(parseArgs(['--allow=203.0.113.7/32, 198.51.100.0/24'])).toEqual({
      off: false,
      allow: ['203.0.113.7/32', '198.51.100.0/24'],
    });
  });

  test('a bad range, an unknown flag, and --allow with --off are errors, not silently ignored', () => {
    expect(parseArgs(['--allow=1.2.3.4'])).toHaveProperty('error');
    expect(parseArgs(['--public'])).toHaveProperty('error');
    expect(parseArgs(['--off', '--allow=1.2.3.4/32'])).toHaveProperty('error');
  });

  test('world-open is detected so the script can warn', () => {
    expect(isWorldOpen('0.0.0.0/0')).toBe(true);
    expect(isWorldOpen('10.0.0.0/8')).toBe(false);
  });
});

// The default MUST stay private: public is an explicit opt-in overlay.
const kubectlAvailable = spawnSync('kubectl', ['version', '--client'], { encoding: 'utf8' }).status === 0;
const repo = path.resolve(__dirname, '..', '..');
const render = (dir: string): string =>
  spawnSync('kubectl', ['kustomize', path.join(repo, 'k8s', dir)], { encoding: 'utf8' }).stdout;
const serviceBlock = (yaml: string): string => {
  const docs = yaml.split(/^---$/m);
  return docs.find((d) => /kind: Service/.test(d) && /name: frontend-external/.test(d)) ?? '';
};

(kubectlAvailable ? describe : describe.skip)('storefront manifests', () => {
  test('the base keeps the storefront private (ClusterIP, no load balancer annotation)', () => {
    const svc = serviceBlock(render('online-boutique'));
    expect(svc).toMatch(/type: ClusterIP/);
    expect(svc).not.toMatch(/aws-load-balancer/);
  });

  test('the public overlay makes only the storefront Service a LoadBalancer, as an NLB', () => {
    const rendered = render('online-boutique-public');
    const svc = serviceBlock(rendered);
    expect(svc).toMatch(/type: LoadBalancer/);
    expect(svc).toMatch(/service\.beta\.kubernetes\.io\/aws-load-balancer-type: nlb/);
    // the internal `frontend` Service and everything else stay as they were
    const lbCount = (rendered.match(/type: LoadBalancer/g) ?? []).length;
    expect(lbCount).toBe(1);
  });

  test('the overlay changes nothing else: same objects as the base', () => {
    const names = (y: string) => [...y.matchAll(/^kind: (\w+)\nmetadata:\n(?:.*\n)*?\s+name: ([\w-]+)/gm)].map((m) => `${m[1]}/${m[2]}`).sort();
    expect(names(render('online-boutique-public'))).toEqual(names(render('online-boutique')));
  });
});
