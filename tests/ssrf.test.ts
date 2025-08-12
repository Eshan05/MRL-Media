import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isPrivateAddress, looksPrivateHost, postJsonToWebhook } from '../src/ssrf.js';

describe('isPrivateAddress', () => {
  it('blocks the private and reserved v4 ranges', () => {
    for (const ip of [
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata — the classic SSRF target
      '172.16.0.1',
      '172.31.255.1',
      '192.0.2.10',
      '192.168.1.4',
      '198.18.0.1',
      '198.51.100.22',
      '203.0.113.9',
      '224.0.0.1',
      '240.0.0.1',
      '0.0.0.0',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public v4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '11.0.0.1', '128.101.101.101']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('blocks private v6 including v4-mapped', () => {
    for (const ip of [
      '::1',
      '::',
      '100::1',
      '2001:db8::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:10.0.0.1',
      '::ffff:192.168.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public v6', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('looksPrivateHost', () => {
  it('blocks obvious local hostnames', () => {
    for (const host of ['localhost', 'foo.localhost', 'printer.local', 'db.internal', '127.0.0.1', '[::1]']) {
      expect(looksPrivateHost(host), host).toBe(true);
    }
  });

  it('lets public hostnames through to the resolve-time check', () => {
    for (const host of ['example.com', 'hooks.slack.com', '8.8.8.8']) {
      expect(looksPrivateHost(host), host).toBe(false);
    }
  });
});

describe('postJsonToWebhook', () => {
  it('does not follow redirects after the destination is resolved', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/metadata');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected tcp server address');

      const res = await postJsonToWebhook(`http://127.0.0.1:${address.port}/hook`, { ok: true }, { allowPrivate: true });
      expect(res.status).toBe(302);
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
