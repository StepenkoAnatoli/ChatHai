// Sends hand-built WebSocket frames over a raw TCP socket (RFC 6455) to check frame parsing:
// all length encodings, fragmentation, ping/pong, close, unmasked and oversized frames, split and coalesced TCP writes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livechat-frames-'));
const app = await startServer({ port: 0, dataFile: path.join(dir, 'data.json'), seedDemo: true });

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.stack}`);
    process.exitCode = 1;
  }
}

function encode(opcode, payload, { fin = true, mask = true } = {}) {
  const len = payload.length;
  const m = mask ? 0x80 : 0;
  let head;
  if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, m | len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = m | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0) | opcode;
    head[1] = m | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([head, payload]);
  const key = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i] ^= key[i % 4];
  return Buffer.concat([head, key, body]);
}

function connect(vid) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(app.port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let shaken = false;
    let closed = false;
    const frames = [];
    let wake = null;
    const notify = () => {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };
    const client = {
      socket,
      write: (b) => socket.write(b),
      send: (opcode, payload, opts) => socket.write(encode(opcode, Buffer.from(payload), opts)),
      sendJson: (obj, opts) => socket.write(encode(1, Buffer.from(JSON.stringify(obj)), opts)),
      async next(ms = 2000) {
        const end = Date.now() + ms;
        while (!frames.length && !closed && Date.now() < end) {
          await new Promise((r) => {
            wake = r;
            setTimeout(r, Math.max(1, end - Date.now()));
          });
        }
        if (frames.length) return frames.shift();
        return closed ? { closed: true } : { timeout: true };
      },
      // next text frame whose JSON matches, skipping others (history, bot answers, ...)
      async nextJson(pred, ms = 2000) {
        const end = Date.now() + ms;
        for (;;) {
          const f = await client.next(Math.max(1, end - Date.now()));
          if (f.closed || f.timeout) return f;
          if (f.opcode !== 1) continue;
          const j = JSON.parse(f.payload.toString('utf8'));
          if (pred(j)) return j;
        }
      },
    };
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!shaken) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.subarray(0, i).toString();
        buf = buf.subarray(i + 4);
        if (!head.startsWith('HTTP/1.1 101')) {
          socket.destroy();
          return reject(new Error(`handshake failed: ${head.split('\r\n')[0]}`));
        }
        shaken = true;
        resolve(client);
      }
      for (;;) {
        if (buf.length < 2) break;
        const fin = !!(buf[0] & 0x80);
        const opcode = buf[0] & 15;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) break;
        frames.push({ fin, opcode, payload: Buffer.from(buf.subarray(off, off + len)) });
        buf = buf.subarray(off + len);
      }
      notify();
    });
    socket.on('close', () => {
      closed = true;
      notify();
    });
    socket.on('error', () => {});
    const key = crypto.randomBytes(16).toString('base64');
    socket.write(
      `GET /ws?role=visitor&key=demo&vid=${vid} HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });
}

const echoed = (text) => (j) => j.type === 'message' && j.message.from === 'visitor' && j.message.text === text;
const closeCode = (f) => (f.opcode === 8 && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null);

console.log('Running WebSocket frame tests');

await test('text frames of every length encoding (7-bit, 16-bit) arrive intact', async () => {
  const c = await connect('frames-lengths-01');
  await c.nextJson((j) => j.type === 'history');
  for (const n of [5, 125, 126, 300, 1999]) {
    const text = 'x'.repeat(n);
    c.sendJson({ type: 'message', text });
    const got = await c.nextJson(echoed(text));
    assert.ok(!got.closed && !got.timeout, `length ${n} not echoed`);
  }
  c.socket.destroy();
});

await test('a 70 KB frame (64-bit length) is refused with close code 1009', async () => {
  const c = await connect('frames-big-0001');
  await c.nextJson((j) => j.type === 'history');
  c.sendJson({ type: 'message', text: 'y'.repeat(70000) });
  let f;
  do f = await c.next(); while (f.opcode !== undefined && f.opcode !== 8);
  assert.equal(closeCode(f), 1009);
  c.socket.destroy();
});

await test('a fragmented message with a ping in the middle is reassembled, and the ping is answered', async () => {
  const c = await connect('frames-frag-0001');
  await c.nextJson((j) => j.type === 'history');
  const whole = Buffer.from(JSON.stringify({ type: 'message', text: 'fragmented hello' }));
  c.write(encode(1, whole.subarray(0, 10), { fin: false }));
  c.write(encode(9, Buffer.from('p1'))); // control frames may appear between fragments
  c.write(encode(0, whole.subarray(10, 20), { fin: false }));
  c.write(encode(0, whole.subarray(20), { fin: true }));
  let pong = null;
  let echo = null;
  const end = Date.now() + 3000;
  while (Date.now() < end && !(pong && echo)) {
    const f = await c.next(Math.max(1, end - Date.now()));
    if (f.closed || f.timeout) break;
    if (f.opcode === 10) pong = f.payload.toString();
    if (f.opcode === 1) {
      const j = JSON.parse(f.payload.toString('utf8'));
      if (j.type === 'message' && j.message.from === 'visitor') echo = j.message.text;
    }
  }
  assert.equal(pong, 'p1', 'the ping inside the fragmented message must be answered');
  assert.equal(echo, 'fragmented hello', 'the fragments must be joined into one message');
  c.socket.destroy();
});

await test('ping gets a pong with the same payload', async () => {
  const c = await connect('frames-ping-0001');
  c.send(9, 'hello-ping');
  let f;
  do f = await c.next(); while (f.opcode !== undefined && f.opcode !== 10);
  assert.equal(f.opcode, 10);
  assert.equal(f.payload.toString(), 'hello-ping');
  c.socket.destroy();
});

await test('an unmasked client frame closes the connection (1002)', async () => {
  const c = await connect('frames-nomask-01');
  await c.nextJson((j) => j.type === 'history');
  c.write(encode(1, Buffer.from(JSON.stringify({ type: 'message', text: 'no mask' })), { mask: false }));
  let f;
  do f = await c.next(); while (f.opcode !== undefined && f.opcode !== 8);
  assert.equal(closeCode(f), 1002);
  c.socket.destroy();
});

await test('a binary frame is ignored and the connection keeps working', async () => {
  const c = await connect('frames-binary-01');
  await c.nextJson((j) => j.type === 'history');
  c.send(2, Buffer.from([1, 2, 3, 4]));
  c.sendJson({ type: 'message', text: 'after binary' });
  const got = await c.nextJson(echoed('after binary'));
  assert.ok(!got.closed && !got.timeout);
  c.socket.destroy();
});

await test('three messages in one TCP write are all processed', async () => {
  const c = await connect('frames-batch-001');
  await c.nextJson((j) => j.type === 'history');
  const frame = (t) => encode(1, Buffer.from(JSON.stringify({ type: 'message', text: t })));
  c.write(Buffer.concat([frame('batch one'), frame('batch two'), frame('batch three')]));
  for (const t of ['batch one', 'batch two', 'batch three']) {
    const got = await c.nextJson(echoed(t));
    assert.ok(!got.closed && !got.timeout, `${t} missing`);
  }
  c.socket.destroy();
});

await test('a frame split across TCP writes (even inside the header) is reassembled', async () => {
  const c = await connect('frames-split-0001');
  await c.nextJson((j) => j.type === 'history');
  const bytes = encode(1, Buffer.from(JSON.stringify({ type: 'message', text: 'split across packets' })));
  c.write(bytes.subarray(0, 1));
  await new Promise((r) => setTimeout(r, 50));
  c.write(bytes.subarray(1, 7));
  await new Promise((r) => setTimeout(r, 50));
  c.write(bytes.subarray(7));
  const got = await c.nextJson(echoed('split across packets'));
  assert.ok(!got.closed && !got.timeout);
  c.socket.destroy();
});

await test('a close frame is answered with a close frame and the socket ends', async () => {
  const c = await connect('frames-close-001');
  await c.nextJson((j) => j.type === 'history');
  const code = Buffer.alloc(2);
  code.writeUInt16BE(1000, 0);
  c.send(8, code);
  let f;
  do f = await c.next(); while (f.opcode !== undefined && f.opcode !== 8);
  assert.equal(f.opcode, 8);
  const after = await c.next(2000);
  assert.ok(after.closed, 'socket should be closed after the close handshake');
});

await app.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
