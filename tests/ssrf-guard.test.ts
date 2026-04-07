import { describe, it, expect } from 'vitest';
import { assertPublicUrl } from '../src/services/ssrf-guard.js';
import { ValidationError } from '../src/errors.js';

function expectBlocked(url: string): void {
  let thrown: unknown = null;
  try {
    assertPublicUrl(url);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
  expect((thrown as ValidationError).message).toMatch(/^BLOCKED_URL/);
}

describe('assertPublicUrl', () => {
  it('allows public https URLs', () => {
    expect(() => assertPublicUrl('https://api.example.com')).not.toThrow();
    expect(() => assertPublicUrl('https://example.com:8080/path?x=1')).not.toThrow();
    expect(() => assertPublicUrl('http://example.com/hook')).not.toThrow();
  });

  it('blocks loopback IPv4 (127.0.0.1, 127.5.6.7)', () => {
    expectBlocked('http://127.0.0.1/hook');
    expectBlocked('https://127.5.6.7:8080/x');
  });

  it('blocks link-local and cloud metadata (169.254.x.x)', () => {
    expectBlocked('http://169.254.169.254/latest/meta-data/');
    expectBlocked('http://169.254.1.1/');
  });

  it('blocks RFC1918 private ranges', () => {
    expectBlocked('http://10.0.0.1/');
    expectBlocked('http://172.16.0.1/');
    expectBlocked('http://172.31.255.1/');
    expectBlocked('http://192.168.1.1/');
  });

  it('blocks 0.0.0.0/8 and multicast/reserved ranges', () => {
    expectBlocked('http://0.0.0.0/');
    expectBlocked('http://0.1.2.3/');
    expectBlocked('http://224.0.0.1/');
    expectBlocked('http://239.255.255.255/');
  });

  it('blocks IPv6 loopback and unspecified', () => {
    expectBlocked('http://[::1]/');
    expectBlocked('http://[::]/');
  });

  it('blocks IPv6 link-local (fe80::/10) and ULA (fc00::/7)', () => {
    expectBlocked('http://[fe80::1]/');
    expectBlocked('http://[fc00::1]/');
    expectBlocked('http://[fd12:3456:789a::1]/');
  });

  it('blocks localhost / metadata.google.internal / 0.0.0.0 hostnames', () => {
    expectBlocked('http://localhost/');
    expectBlocked('http://localhost:3000/');
    expectBlocked('http://metadata.google.internal/');
  });

  it('blocks non-http schemes', () => {
    expectBlocked('file:///etc/passwd');
    expectBlocked('javascript:alert(1)');
    expectBlocked('ftp://example.com/');
    expectBlocked('gopher://example.com/');
  });

  it('blocks bare hostnames without a dot', () => {
    expectBlocked('http://internal-service/hook');
    expectBlocked('http://redis/');
  });

  it('blocks malformed URLs', () => {
    expectBlocked('not a url');
    expectBlocked('');
  });
});
