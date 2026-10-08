/** L3 SSRF hard gate — no network. Run: node ./test/ssrf-check.mjs
 *
 * 100% block is the release bar: any miss fails the suite (exit 1). This
 * covers URL *shapes*; redirect-hop validation is exercised in
 * test/reader-check.mjs via resolveRedirect (the exact per-hop guard
 * fetchValidated applies).
 *
 * Known limitation (documented, not solved): DNS rebinding inside a short
 * TTL window. No raw-socket DNS pinning without extra deps, so a hostname
 * that resolves public at check time but private at connect time (within
 * milliseconds) is mitigated by short timeouts + per-hop revalidation, not
 * eliminated. There is deliberately no loopback fixture server: localhost
 * is guard-blocked by design, so such a server could never exercise the
 * fetch path it pretends to test.
 */
import { assertPublicUrl, resolveRedirect } from '../lib/reader.js';

let pass = 0;
let fail = 0;
function blocked(url, why) {
  try {
    assertPublicUrl(url);
  } catch {
    pass++;
    return;
  }
  fail++;
  console.error(`FAIL (allowed ${why}): ${url}`);
}
function allowed(url, why) {
  try {
    assertPublicUrl(url);
    pass++;
  } catch (e) {
    fail++;
    console.error(`FAIL (wrongly blocked ${why}): ${url} — ${e.message}`);
  }
}

// IPv4: loopback / private / link-local / CGNAT / 0/8 — dotted forms
for (const bad of [
  'http://127.0.0.1/',
  'http://127.1/', // short form → 127.0.0.1
  'http://127.0.1/', // short form → 127.0.0.1
  'http://10.1.2.3/',
  'http://10.0.0.1/',
  'http://172.16.0.1/',
  'http://172.20.5.5/',
  'http://172.31.255.255/',
  'http://192.168.1.1/',
  'http://192.168.0.1/',
  'http://169.254.169.254/', // cloud metadata
  'http://169.254.10.20/',
  'http://100.64.0.1/', // CGNAT
  'http://100.127.255.255/',
  'http://0.0.0.0/',
  'http://0.0.0.0:8080/',
]) {
  blocked(bad, 'v4 range');
}
// IPv4: hex / octal / single-integer evasions (inet_aton forms)
for (const bad of [
  'http://0x7f.0.0.1/',
  'http://0X7F.0.0.1/',
  'http://0xC0.0xA8.0x1.0x1/', // 192.168.1.1
  'http://0177.0.0.1/', // octal 177 = 127
  'http://0300.0250.0.01/', // octal 192.168.0.1
  'http://2130706433/', // 127.0.0.1 as int
  'http://0x7f000001/', // 127.0.0.1 as hex int
  'http://3232235777/', // 192.168.1.1 as int
  'http://167772161/', // 10.0.0.1 as int
]) {
  blocked(bad, 'v4 evasion');
}
// IPv6: loopback / link-local / unique-local / multicast / mapped
for (const bad of [
  'http://[::1]/',
  'http://[::]/',
  'http://[fe80::1]/',
  'http://[fc00::1]/',
  'http://[fd00::5]/',
  'http://[ff02::1]/',
  'http://[::ffff:127.0.0.1]/', // mapped loopback
  'http://[::ffff:10.0.0.1]/', // mapped private
  'http://localhost/',
  'http://LOCALHOST:3000/',
  'http://foo.localhost/',
]) {
  blocked(bad, 'v6/localhost');
}
// Reserved / internal suffixes + dotless hosts
for (const bad of [
  'http://foo.local/',
  'http://foo.internal/',
  'http://foo.invalid/',
  'http://foo.test/',
  'http://foo.example/',
  'http://foo.lan/',
  'http://foo.home/',
  'http://foo.corp/',
  'http://intranet/',
  'http://router/',
  'http://localhost:29395/http://example.com/', // would-be proxy bypass shape
  'ftp://example.com/file',
  'javascript:alert(1)',
]) {
  blocked(bad, 'suffix/dotless/scheme');
}
// Redirect targets: the per-hop guard must refuse these too
for (const bad of ['http://169.254.169.254/latest', 'http://10.0.0.5/admin', 'http://[::1]/x']) {
  try {
    resolveRedirect('https://public-example.com/start', bad);
    fail++;
    console.error(`FAIL (allowed redirect target): ${bad}`);
  } catch {
    pass++;
  }
}
// Must NOT break the public web
for (const good of [
  'https://example.com/',
  'https://www.example.com:443/path?q=1#frag',
  'http://8.8.8.8/',
  'https://1.1.1.1/',
  'http://[2606:4700:4700::1111]/', // public v6 (Cloudflare DNS)
  'https://en.wikipedia.org/wiki/X',
  'https://news.ycombinator.com/item?id=123',
]) {
  allowed(good, 'public');
}

console.log(`\nSSRF CHECK: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
