// origin-guard.test.mjs — the WS upgrade must reject cross-origin browser pages (CSRF), so a
// random page you visit can't open ws://127.0.0.1:PORT and drive replay. App reporters (no Origin
// header at all) and the served GUI page (same-origin / loopback) must still connect.
// `Origin: null` is a BROWSER value (a sandboxed iframe's opaque origin), so it is rejected unless
// the operator explicitly opts in with allowNullOrigin / --allow-null-origin.

import { originAllowed, startGui } from '../gui/server.mjs';
import net from 'node:net';
import crypto from 'node:crypto';
import { once } from 'node:events';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const mk = (origin, host = '127.0.0.1:9491') => ({ headers: { host, ...(origin === undefined ? {} : { origin }) } });

console.log('origin-guard.test.mjs — WS upgrade CSRF guard\n');

// ---- unit: originAllowed ----
check('absent Origin allowed (app reporter, non-browser)', originAllowed(mk(undefined)) === true);
// A sandboxed / cross-origin-redirected browsing context serializes its OPAQUE origin as exactly
// "null", so allowing it let any page a dev visits drive this GUI. Absent-Origin (above) is what
// real non-browser reporters send.
check('CONTROL: \'null\' Origin REJECTED (sandboxed iframe forges it)', originAllowed(mk('null')) === false);
check('CONTROL: \'null\' Origin still rejected when opt-in is false', originAllowed(mk('null'), { allowNullOrigin: false }) === false);
check("opt-in allowNullOrigin re-admits 'null' Origin", originAllowed(mk('null'), { allowNullOrigin: true }) === true);
check('loopback Origin allowed (localhost)', originAllowed(mk('http://localhost:9491')) === true);
check('loopback Origin allowed (127.0.0.1)', originAllowed(mk('http://127.0.0.1:9491')) === true);
check('same-host Origin allowed (deliberate LAN bind)', originAllowed(mk('http://192.168.1.5:9491', '192.168.1.5:9491')) === true);
check('CONTROL: cross-origin page REJECTED (evil.com)', originAllowed(mk('http://evil.com')) === false);
check('CONTROL: cross-origin https page REJECTED', originAllowed(mk('https://attacker.example')) === false);
check('CONTROL: malformed Origin REJECTED', originAllowed(mk('!!not a url')) === false);

// ---- integration: a real server refuses the cross-origin upgrade, accepts the loopback one ----
const PORT = 9491;
const DEAD_PORT = 9492;              // nothing listens here — proves 'unreachable' is distinguishable
const server = startGui({ port: PORT });
await once(server, 'listening');     // deterministic: no sleep-and-hope race

// Raw-socket WS upgrade so we see exactly what happened. The verdict DISTINGUISHES a rejection by
// the guard (TCP connected, server destroyed the socket without writing a byte) from never having
// reached the server at all — otherwise a dead port would score as a passing CSRF control.
function upgrade(origin, port = PORT) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let connected = false;
    let settled = false;
    const verdict = () => {
      if (!connected) return 'unreachable';                    // never got a TCP connection
      if (buf.startsWith('HTTP/1.1 101')) return 'upgraded';
      if (buf === '') return 'rejected-by-guard';              // connected, then socket.destroy()
      return 'http-error';                                     // an actual HTTP response, not 101
    };
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch {} resolve(v); };
    const timer = setTimeout(() => done(connected ? 'hung' : 'unreachable'), 1000);
    sock.on('connect', () => {
      connected = true;
      let r = `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
        + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n`;
      if (origin) r += `Origin: ${origin}\r\n`;
      sock.write(r + '\r\n');
    });
    sock.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n\r\n')) done(verdict()); });
    sock.on('close', () => done(verdict()));
    sock.on('error', () => done(verdict()));
  });
}

// Meta-control: the verdict must not confuse "no server" with "guard said no".
check('CONTROL: a dead port reads as unreachable, NOT as a guard rejection', (await upgrade('http://evil.com', DEAD_PORT)) === 'unreachable');
check('CONTROL: server REJECTS cross-origin upgrade (evil.com)', (await upgrade('http://evil.com')) === 'rejected-by-guard');
check("CONTROL: server REJECTS 'null' Origin upgrade (sandboxed iframe)", (await upgrade('null')) === 'rejected-by-guard');
check('server ACCEPTS loopback upgrade (the GUI page)', (await upgrade(`http://localhost:${PORT}`)) === 'upgraded');
check('server ACCEPTS no-Origin upgrade (app reporter)', (await upgrade(undefined)) === 'upgraded');

// A server started with the explicit opt-in DOES accept 'null' — proves the flag is wired through
// startGui to the guard, and that the rejection above is the flag's default, not an unrelated failure.
const optIn = startGui({ port: DEAD_PORT, allowNullOrigin: true });
await once(optIn, 'listening');
check("opt-in server ACCEPTS 'null' Origin (--allow-null-origin)", (await upgrade('null', DEAD_PORT)) === 'upgraded');
optIn.close();

server.close();
console.log(failures === 0 ? '\nAll origin-guard claims verified.' : `\n${failures} claim(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
