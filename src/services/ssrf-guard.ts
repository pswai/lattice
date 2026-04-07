import { isIP } from 'net';
import { ValidationError } from '../errors.js';

/**
 * Block SSRF-prone URLs before we hand them to `fetch`. Rejects non-http(s)
 * schemes, private/loopback/link-local/multicast IP ranges, cloud metadata
 * endpoints, and bare hostnames without a dot.
 *
 * Throws `ValidationError('BLOCKED_URL: <reason>')`. Caller may re-wrap.
 */
export function assertPublicUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationError('BLOCKED_URL: invalid URL');
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new ValidationError(`BLOCKED_URL: scheme ${scheme} not allowed`);
  }

  // Hostname arrives lowercased by URL parser, IPv6 comes wrapped in `[]`.
  const rawHost = parsed.hostname;
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;

  if (!hostname) {
    throw new ValidationError('BLOCKED_URL: missing host');
  }

  const lower = hostname.toLowerCase();

  // Cloud metadata + localhost-style names.
  const BLOCKED_NAMES = new Set([
    'localhost',
    '0.0.0.0',
    'metadata.google.internal',
    'metadata',
  ]);
  if (BLOCKED_NAMES.has(lower)) {
    throw new ValidationError(`BLOCKED_URL: host ${lower} not allowed`);
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    if (isPrivateIPv4(hostname)) {
      throw new ValidationError(`BLOCKED_URL: private IPv4 ${hostname}`);
    }
    return;
  }
  if (ipVersion === 6) {
    if (isPrivateIPv6(hostname)) {
      throw new ValidationError(`BLOCKED_URL: private IPv6 ${hostname}`);
    }
    return;
  }

  // Not a raw IP — require at least one dot so bare internal hostnames like
  // `redis` or `internal-service` are blocked.
  if (!lower.includes('.')) {
    throw new ValidationError(`BLOCKED_URL: bare hostname ${lower} not allowed`);
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return true; // malformed → treat as blocked
  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const [a, b] = octets;
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (includes AWS/GCP metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Unspecified :: and loopback ::1
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped ::ffff:a.b.c.d — check embedded v4.
  const v4MappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) return isPrivateIPv4(v4MappedMatch[1]);
  // Expand to full 8 groups to inspect prefix bits.
  const groups = expandIPv6(lower);
  if (!groups) return true; // malformed → block
  const first = groups[0];
  // fe80::/10 link-local — first 10 bits: 1111 1110 10xx xxxx
  if ((first & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique-local — first 7 bits: 1111 110x
  if ((first & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

function expandIPv6(ip: string): number[] | null {
  // Split on '::' to handle zero-compression.
  const doubleColon = ip.split('::');
  if (doubleColon.length > 2) return null;
  const left = doubleColon[0] ? doubleColon[0].split(':') : [];
  const right = doubleColon.length === 2 && doubleColon[1] ? doubleColon[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (doubleColon.length === 1 && left.length !== 8) return null;
  if (doubleColon.length === 2 && missing < 0) return null;
  const zeros = doubleColon.length === 2 ? new Array<string>(missing).fill('0') : [];
  const parts = [...left, ...zeros, ...right];
  if (parts.length !== 8) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out;
}
