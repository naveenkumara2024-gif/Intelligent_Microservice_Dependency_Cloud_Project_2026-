// Pure helpers for expose-storefront.ts (unit-tested in test/storefront.test.ts).

const CIDR_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** Validates an IPv4 CIDR such as 203.0.113.7/32. Returns an error message, or undefined if valid. */
export function cidrProblem(cidr: string): string | undefined {
  const m = CIDR_V4.exec(cidr.trim());
  if (!m) return `"${cidr}" is not an IPv4 CIDR like 203.0.113.7/32`;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return `"${cidr}" has an octet above 255`;
  if (Number(m[5]) > 32) return `"${cidr}" has a prefix length above 32`;
  return undefined;
}

export interface ExposeOptions {
  off: boolean;
  /** Source ranges allowed to reach the load balancer; empty means open to the internet. */
  allow: string[];
}

export function parseArgs(argv: string[]): ExposeOptions | { error: string } {
  let off = false;
  const allow: string[] = [];
  for (const arg of argv) {
    if (arg === '--off') {
      off = true;
    } else if (arg.startsWith('--allow=')) {
      for (const part of arg.slice('--allow='.length).split(',')) {
        if (!part.trim()) continue;
        const problem = cidrProblem(part);
        if (problem) return { error: problem };
        allow.push(part.trim());
      }
    } else {
      return { error: `unknown argument ${arg} (use --off and/or --allow=<cidr>[,<cidr>])` };
    }
  }
  if (off && allow.length > 0) return { error: '--allow has no meaning with --off' };
  return { off, allow };
}

/** True for the world-open ranges, which make `--allow` pointless and should be called out. */
export function isWorldOpen(cidr: string): boolean {
  return cidr.trim() === '0.0.0.0/0';
}
