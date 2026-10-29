import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livechat-test-'));
const dataFile = path.join(dir, 'data.json');
const ADMIN = 'test-admin-token-1234';
const app = await startServer({ port: 0, dataFile, seedDemo: true, adminToken: ADMIN });
const base = `http://127.0.0.1:${app.port}`;
const wsBase = `ws://127.0.0.1:${app.port}`;

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

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

// WebSocket helper that collects messages and lets a test wait for one matching a predicate.
function connect(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    const inbox = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const i = waiters.findIndex((w) => w.pred(data));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(data);
      else inbox.push(data);
    };
    ws.onopen = () =>
      resolve({
        ws,
        next(pred, ms = 2000) {
          const i = inbox.findIndex(pred);
          if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const waiter = { pred, resolve: (d) => (clearTimeout(t), res(d)) };
            const t = setTimeout(() => {
              const idx = waiters.indexOf(waiter);
              if (idx >= 0) waiters.splice(idx, 1);
              rej(new Error('timed out waiting for message'));
            }, ms);
            waiters.push(waiter);
          });
        },
        send: (obj) => ws.send(JSON.stringify(obj)),
        close: () => ws.close(),
      });
    ws.onerror = () => reject(new Error('ws error'));
    ws.onclose = (e) => reject(new Error(`ws closed ${e.code}`));
  });
}

const tryConnect = (url) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.onopen = () => (ws.close(), resolve('open'));
    ws.onerror = () => resolve('rejected');
  });

console.log('Running live chat end-to-end tests');

let token;

await test('serves widget, demo page and dashboard root; blocks path traversal', async () => {
  for (const p of ['/widget.js', '/demo']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
  }
  // '/' is the built dashboard (200), or a short hint (503) before `npm run build`.
  const root = await fetch(base + '/');
  assert.ok([200, 503].includes(root.status), `dashboard root returned ${root.status}`);
  assert.equal((await fetch(base + '/..%2F..%2Fserver%2Fstore.js')).status, 404, 'no path traversal');
});

await test('public site config works with CORS, unknown site is 404', async () => {
  const ok = await api('/api/site-config?key=demo');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'חנות הדגמה');
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.equal((await api('/api/site-config?key=nope')).status, 404);
  assert.equal((await api('/api/site-config?key=__proto__')).status, 404);
});

await test('login rejects bad password and accepts the right one', async () => {
  const post = (body) =>
    api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ siteKey: 'demo', password: 'wrong' })).status, 401);
  assert.equal((await post({ siteKey: 'ghost', password: 'demo123' })).status, 401);
  const ok = await post({ siteKey: 'demo', password: 'demo123' });
  assert.equal(ok.status, 200);
  token = ok.body.token;
  assert.ok(token);
});

await test('protected endpoints need a token', async () => {
  assert.equal((await api('/api/conversations')).status, 401);
  assert.equal((await api('/api/faq')).status, 401);
  const ok = await api('/api/conversations', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
});

await test('websocket rejects bad agent token, bad site, bad visitor id', async () => {
  assert.equal(await tryConnect(`${wsBase}/ws?role=agent&token=bad`), 'rejected');
  assert.equal(await tryConnect(`${wsBase}/ws?role=visitor&key=nope&vid=visitor-0001`), 'rejected');
  assert.equal(await tryConnect(`${wsBase}/ws?role=visitor&key=demo&vid=x`), 'rejected');
});

const vid = 'visitor-abc12345';
let visitor;
let agent;

await test('visitor connects and gets empty history; agent connects', async () => {
  agent = await connect(`${wsBase}/ws?role=agent&token=${token}`);
  visitor = await connect(`${wsBase}/ws?role=visitor&key=demo&vid=${vid}`);
  const history = await visitor.next((m) => m.type === 'history');
  assert.deepEqual(history.messages, []);
});

await test('FAQ question gets a bot answer and agent sees both messages', async () => {
  visitor.send({ type: 'message', text: 'מה שעות הפעילות?' });
  const botMsg = await visitor.next((m) => m.type === 'message' && m.message.from === 'bot');
  assert.match(botMsg.message.text, /ימים א׳–ה׳/);
  const seen = await agent.next((m) => m.type === 'message' && m.message.from === 'visitor');
  assert.equal(seen.convId, `demo:${vid}`);
  assert.equal(seen.conv.needsHuman, false);
  await agent.next((m) => m.type === 'message' && m.message.from === 'bot');
});

await test('unknown question gets fallback once and flags needsHuman', async () => {
  visitor.send({ type: 'message', text: 'האם אתם מוכרים פילים סגולים?' });
  const fb = await visitor.next((m) => m.type === 'message' && m.message.from === 'bot');
  assert.match(fb.message.text, /נציג יחזור אליך/);
  const flagged = await agent.next((m) => m.type === 'message' && m.message.from === 'bot');
  assert.equal(flagged.conv.needsHuman, true);
  visitor.send({ type: 'message', text: 'Hello? Anyone there?' });
  await agent.next((m) => m.type === 'conversation' && m.conv.needsHuman === true);
  // no second fallback should be sent
  await assert.rejects(visitor.next((m) => m.type === 'message' && m.message.from === 'bot', 300));
});

await test('agent reply reaches visitor and stops the bot', async () => {
  agent.send({ type: 'reply', convId: `demo:${vid}`, text: 'Hi, this is Dana. Let me check.' });
  const got = await visitor.next((m) => m.type === 'message' && m.message.from === 'agent');
  assert.equal(got.message.text, 'Hi, this is Dana. Let me check.');
  visitor.send({ type: 'message', text: 'כמה עולה משלוח?' });
  await agent.next((m) => m.type === 'message' && m.message.text === 'כמה עולה משלוח?');
  await assert.rejects(visitor.next((m) => m.type === 'message' && m.message.from === 'bot', 300));
});

await test('closing a conversation resumes the bot after the visitor returns', async () => {
  agent.send({ type: 'close', convId: `demo:${vid}` });
  const closed = await agent.next((m) => m.type === 'conversation' && m.conv.status === 'closed');
  assert.equal(closed.conv.humanTakeover, false);
  visitor.send({ type: 'message', text: 'כמה עולה משלוח?' });
  const botMsg = await visitor.next((m) => m.type === 'message' && m.message.from === 'bot');
  assert.match(botMsg.message.text, /משלוח חינם/);
});

await test('reconnecting visitor receives history; conversations API lists it', async () => {
  visitor.close();
  const again = await connect(`${wsBase}/ws?role=visitor&key=demo&vid=${vid}`);
  const history = await again.next((m) => m.type === 'history');
  assert.ok(history.messages.length >= 7);
  again.close();
  const list = await api('/api/conversations', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(list.body.conversations.length, 1);
  assert.equal(list.body.conversations[0].id, `demo:${vid}`);
});

await test('FAQ and settings can be edited and validated', async () => {
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const put = await api('/api/faq', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ faq: [{ q: 'Do you ship abroad?', a: 'Yes, worldwide.', keywords: 'international abroad' }, { q: '', a: 'dropped' }] }),
  });
  assert.equal(put.body.faq.length, 1);
  const bad = await api('/api/settings', { method: 'PUT', headers: auth, body: JSON.stringify({ color: 'red' }) });
  assert.equal(bad.status, 400);
  const good = await api('/api/settings', { method: 'PUT', headers: auth, body: JSON.stringify({ color: '#ff6600', greeting: 'Welcome!' }) });
  assert.equal(good.body.color, '#ff6600');
  const cfg = await api('/api/site-config?key=demo');
  assert.equal(cfg.body.greeting, 'Welcome!');
});

await test('allowedOrigins blocks visitors from other origins', async () => {
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  await api('/api/settings', { method: 'PUT', headers: auth, body: JSON.stringify({ allowedOrigins: ['https://client.example'] }) });
  // Node's WebSocket sends no Origin header, so it must be refused.
  assert.equal(await tryConnect(`${wsBase}/ws?role=visitor&key=demo&vid=${vid}`), 'rejected');
  await api('/api/settings', { method: 'PUT', headers: auth, body: JSON.stringify({ allowedOrigins: [] }) });
});

await test('admin endpoint creates isolated client sites, and rejects bad tokens', async () => {
  const create = (headers, body) =>
    api('/api/admin/sites', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await create({}, { name: 'Acme' })).status, 401);
  assert.equal((await create({ authorization: 'Bearer wrong-token-wrong-token' }, { name: 'Acme' })).status, 401);
  assert.equal((await create({ authorization: `Bearer ${ADMIN}` }, { name: '' })).status, 400);
  assert.equal((await create({ authorization: `Bearer ${ADMIN}` }, { name: 'Acme', password: 'short' })).status, 400);
  const made = await create({ authorization: `Bearer ${ADMIN}` }, { name: 'Acme', allowedOrigins: [] });
  assert.equal(made.status, 201);
  assert.ok(made.body.key && made.body.password.length >= 8);

  // the new client can log in, and cannot see the demo site's conversations
  const login = await api('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ siteKey: made.body.key, password: made.body.password }),
  });
  assert.equal(login.status, 200);
  const list = await api('/api/conversations', { headers: { authorization: `Bearer ${login.body.token}` } });
  assert.equal(list.body.conversations.length, 0);
  // and the demo token cannot read the new site's data either (tokens are per-site)
  const agentOther = await connect(`${wsBase}/ws?role=agent&token=${login.body.token}`);
  const v = await connect(`${wsBase}/ws?role=visitor&key=${made.body.key}&vid=other-visitor-1`);
  v.send({ type: 'message', text: 'hello from acme' });
  await agentOther.next((m) => m.type === 'message' && m.message.text === 'hello from acme');
  await assert.rejects(agent.next((m) => m.type === 'message' && m.message.text === 'hello from acme', 300));
  v.close();
  agentOther.close();
});

await test('login limiter counts only failures, per real client IP behind a proxy', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'livechat-rl-'));
  const rl = await startServer({ port: 0, dataFile: path.join(d, 'd.json'), seedDemo: true, trustProxy: true });
  const login = async (xff, password) =>
    (
      await fetch(`http://127.0.0.1:${rl.port}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
        body: JSON.stringify({ siteKey: 'demo', password }),
      })
    ).status;
  // Correct logins are never limited, however many there are.
  for (let i = 0; i < 15; i += 1) assert.equal(await login('6.6.6.6, 1.1.1.1', 'demo123'), 200);
  // Ten wrong guesses block that client, even with the right password afterwards.
  for (let i = 0; i < 10; i += 1) assert.equal(await login('6.6.6.6, 2.2.2.2', 'wrong-password'), 401);
  assert.equal(await login('6.6.6.6, 2.2.2.2', 'demo123'), 429);
  // Forging the first X-Forwarded-For entry does not help; the entry the proxy appended identifies the client.
  assert.equal(await login('9.9.9.9, 2.2.2.2', 'demo123'), 429);
  // Other clients behind the same proxy are not affected.
  assert.equal(await login('6.6.6.6, 3.3.3.3', 'demo123'), 200);
  await rl.close();
  fs.rmSync(d, { recursive: true, force: true });
});

await test('logout invalidates the token and closes that agent socket only', async () => {
  const l = await api('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ siteKey: 'demo', password: 'demo123' }),
  });
  const tok = l.body.token;
  const a = await connect(`${wsBase}/ws?role=agent&token=${tok}`);
  const closed = new Promise((res) => (a.ws.onclose = (e) => res(e.code)));
  const out = await api('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${tok}` } });
  assert.equal(out.status, 200);
  assert.equal(await Promise.race([closed, new Promise((r) => setTimeout(() => r('still open'), 2000))]), 1008);
  assert.equal((await api('/api/conversations', { headers: { authorization: `Bearer ${tok}` } })).status, 401);
  assert.equal(await tryConnect(`${wsBase}/ws?role=agent&token=${tok}`), 'rejected');
  // the other session is untouched
  assert.equal((await api('/api/conversations', { headers: { authorization: `Bearer ${token}` } })).status, 200);
});

const upgradeStatus = (urlPath, headers = {}) =>
  new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: app.port,
      path: urlPath,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve('error'));
    req.end();
  });

await test('allowed websites are normalised, validated, and honoured with a real Origin header', async () => {
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const put = (body) => api('/api/settings', { method: 'PUT', headers: auth, body: JSON.stringify(body) });
  const ok = await put({ allowedOrigins: [' https://Client.Example/ ', 'https://client.example', 'http://localhost:8080/path'] });
  assert.deepEqual(ok.body.allowedOrigins, ['https://client.example', 'http://localhost:8080']);

  // A typo must be rejected, not silently ignored (an empty list would let every website in), and must change nothing.
  const bad = await put({ greeting: 'SHOULD NOT STICK', allowedOrigins: ['acme.example'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /אינה כתובת אתר תקינה/);
  assert.equal((await put({ allowedOrigins: ['ftp://x.example'] })).status, 400);
  assert.notEqual((await api('/api/settings', { headers: auth })).body.greeting, 'SHOULD NOT STICK');
  assert.deepEqual((await api('/api/settings', { headers: auth })).body.allowedOrigins, ['https://client.example', 'http://localhost:8080']);

  const path1 = '/ws?role=visitor&key=demo&vid=origin-visitor-1';
  assert.equal(await upgradeStatus(path1, { Origin: 'https://client.example' }), 101);
  assert.equal(await upgradeStatus(path1, { Origin: 'http://localhost:8080' }), 101);
  assert.equal(await upgradeStatus(path1, { Origin: 'https://evil.example' }), 403);
  assert.equal(await upgradeStatus(path1, {}), 403);
  await put({ allowedOrigins: [] });
  assert.equal(await upgradeStatus(path1, { Origin: 'https://anything.example' }), 101);
});

await test('visitor message rate limit is per conversation, not per socket', async () => {
  const v1 = await connect(`${wsBase}/ws?role=visitor&key=demo&vid=flood-visitor-01`);
  await v1.next((m) => m.type === 'history');
  for (let i = 0; i < 20; i += 1) v1.send({ type: 'message', text: `flood ${i}` });
  await new Promise((r) => setTimeout(r, 300));
  v1.close();
  const v2 = await connect(`${wsBase}/ws?role=visitor&key=demo&vid=flood-visitor-01`);
  await v2.next((m) => m.type === 'history');
  v2.send({ type: 'message', text: 'one more' });
  const err = await v2.next((m) => m.type === 'error');
  assert.equal(err.code, 'rate_limited');
  v2.close();
});

await test('hostile input cannot crash the server', async () => {
  // upgrade requests whose path is not a valid URL used to throw inside the upgrade handler
  for (const p of ['//', '//[']) {
    const st = await upgradeStatus(p);
    assert.ok([400, 404].includes(st), `upgrade ${p} -> ${st}`);
  }
  // valid JSON that is not an object (null.type used to throw), from a visitor and from an agent
  const v = await connect(`${wsBase}/ws?role=visitor&key=demo&vid=hostile-visitor-1`);
  await v.next((m) => m.type === 'history');
  for (const junk of ['null', '[]', '5', '"text"', '{"type":"message","text":{"a":1}}']) v.ws.send(junk);
  const a2 = await connect(`${wsBase}/ws?role=agent&token=${token}`);
  for (const junk of ['null', '[]', '5', '"x"', '{"type":"reply","convId":null,"text":"x"}']) a2.ws.send(junk);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await api('/api/site-config?key=demo')).status, 200, 'server must still be alive');
  // and the same connections still work afterwards
  v.send({ type: 'message', text: 'still fine?' });
  assert.ok(await v.next((m) => m.type === 'message' && m.message.text === 'still fine?'));
  v.close();
  a2.close();
});

await test('one IP cannot flood the server with conversations or messages', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'livechat-ip-'));
  const lim = await startServer({ port: 0, dataFile: path.join(d, 'd.json'), seedDemo: true, ipNewConversationsPerHour: 3, ipMessagesPerMinute: 6 });
  const open = async (n) => {
    const c = await connect(`ws://127.0.0.1:${lim.port}/ws?role=visitor&key=demo&vid=flood-ip-visitor-${n}`);
    await c.next((m) => m.type === 'history');
    return c;
  };
  const results = [];
  const conns = [];
  for (let n = 1; n <= 5; n += 1) {
    const c = await open(n);
    conns.push(c);
    c.send({ type: 'message', text: `hello ${n}` });
    const got = await c.next((m) => m.type === 'error' || (m.type === 'message' && m.message.from === 'visitor'));
    results.push(got.type === 'error' ? got.code : 'ok');
  }
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'rate_limited', 'rate_limited'], 'only 3 new conversations per IP');
  assert.equal(Object.keys(lim.store.data.conversations).length, 3, 'refused conversations must not be stored');
  // message limit per IP: 6 per minute (5 attempts so far each consumed one)
  conns[0].send({ type: 'message', text: 'extra 1' });
  assert.equal((await conns[0].next((m) => m.type === 'error' || m.type === 'message')).type, 'message');
  conns[0].send({ type: 'message', text: 'extra 2' });
  assert.equal((await conns[0].next((m) => m.type === 'error' || (m.type === 'message' && m.message.text === 'extra 2'))).code, 'rate_limited');
  conns.forEach((c) => c.close());
  await lim.close();
  fs.rmSync(d, { recursive: true, force: true });
});

await test('the demo site is not created automatically in production', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'livechat-prod-'));
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const prod = await startServer({ port: 0, dataFile: path.join(d, 'a.json') });
    assert.deepEqual(Object.keys(prod.store.data.sites), []);
    await prod.close();
    const forced = await startServer({ port: 0, dataFile: path.join(d, 'b.json'), seedDemo: true });
    assert.deepEqual(Object.keys(forced.store.data.sites), ['demo']);
    await forced.close();
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

await test('email alert: sent once when nobody is in the dashboard and the bot cannot help; settings and privacy note validated', async () => {
  const mails = [];
  let mailStatus = 200;
  const mailSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      mails.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      res.writeHead(mailStatus, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => mailSrv.listen(0, '127.0.0.1', r));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mail-'));
  const { createNotifier } = await import('../server/notify.js');
  const quiet = { error() {} };
  const n = createNotifier({ apiKey: 'key123', from: 'chat@example.com', apiUrl: `http://127.0.0.1:${mailSrv.address().port}/emails`, dashboardUrl: 'https://chat.example.com', minGapMs: 60000, log: quiet });
  const s = await startServer({ port: 0, dataFile: path.join(d, 'd.json'), seedDemo: true, notifier: n });
  const b2 = `http://127.0.0.1:${s.port}`;
  const w2 = `ws://127.0.0.1:${s.port}`;
  const call = async (p, opts) => {
    const r = await fetch(b2 + p, opts);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const tok = (await call('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteKey: 'demo', password: 'demo123' }) })).body.token;
  const auth = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
  const put = (body) => call('/api/settings', { method: 'PUT', headers: auth, body: JSON.stringify(body) });

  // validation, and the default privacy note reaches the public config
  assert.equal((await put({ notifyEmail: 'not an email' })).status, 400);
  assert.equal((await put({ notifyEmail: 'a@b.c\r\nBcc: x@y.z' })).status, 400);
  const cfg0 = await call('/api/site-config?key=demo');
  assert.match(cfg0.body.privacyNote, /נשמרת/);
  const saved = await put({ notifyEmail: ' owner@example.com ', privacyNote: 'נשמר לצורך שירות' });
  assert.equal(saved.body.notifyEmail, 'owner@example.com');
  assert.equal(saved.body.emailEnabled, true);
  assert.equal((await call('/api/site-config?key=demo')).body.privacyNote, 'נשמר לצורך שירות');
  assert.equal((await put({ privacyNote: '' })).status, 200);
  assert.equal((await call('/api/site-config?key=demo')).body.privacyNote, '');

  const talk = async (vid, text) => {
    const v = await connect(`${w2}/ws?role=visitor&key=demo&vid=${vid}`);
    await v.next((m) => m.type === 'history');
    v.send({ type: 'message', text });
    await v.next((m) => m.type === 'message' && m.message.from === 'bot');
    return v;
  };
  const settle = () => new Promise((r) => setTimeout(r, 150));

  // 1) the bot answers from the FAQ: nobody needs to be told
  const v1 = await talk('aaaaaaaa-1', 'מה שעות הפעילות?');
  await settle();
  assert.equal(mails.length, 0, 'FAQ answers send no email');

  // 2) the bot cannot help and no agent is online: one email, with the text, to the right address
  const v2 = await talk('aaaaaaaa-2', 'האם אתם מוכרים פילים סגולים?');
  await settle();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].auth, 'Bearer key123');
  assert.deepEqual(mails[0].body.to, ['owner@example.com']);
  assert.equal(mails[0].body.from, 'chat@example.com');
  assert.match(mails[0].body.text, /פילים סגולים/);
  assert.match(mails[0].body.text, /https:\/\/chat\.example\.com/);

  // 3) more messages in the same chat within the gap do not send more emails
  v2.send({ type: 'message', text: 'הלו? יש מישהו?' });
  await settle();
  assert.equal(mails.length, 1, 'throttled per conversation');

  // 4) an agent is online: no email for a different conversation
  const ag = await connect(`${w2}/ws?role=agent&token=${tok}`);
  const v3 = await talk('aaaaaaaa-3', 'שאלה שאין לבוט עליה תשובה');
  await settle();
  assert.equal(mails.length, 1, 'no email while an agent is watching the dashboard');
  ag.close();
  await new Promise((r) => setTimeout(r, 100));

  // 5) a broken mail service does not hurt the chat
  mailStatus = 500;
  const v4 = await talk('aaaaaaaa-4', 'עוד שאלה בלי תשובה');
  await settle();
  assert.equal(mails.length, 2, 'the failed attempt reached the mail service');
  v4.send({ type: 'message', text: 'וגם אחרי הכישלון הצ׳אט חי' });
  await settle();
  assert.equal(mails.length, 3, 'a failed send does not count toward the throttle');

  // 6) disabled notifier or no address: silent
  const off = createNotifier({ apiKey: '', from: '', log: quiet });
  assert.equal(await off.notify({ name: 'x', notifyEmail: 'a@b.co' }, { id: 'c' }, 'hi'), false);

  for (const v of [v1, v2, v3, v4]) v.close();
  await s.close();
  mailSrv.close();
  fs.rmSync(d, { recursive: true, force: true });
});

await test('data persists to disk', async () => {
  agent.close();
  await app.close();
  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(saved.conversations[`demo:${vid}`].messages.length >= 7, true);
  assert.equal(saved.sites.demo.faq.length, 1);
  assert.ok(saved.sites.demo.passwordHash.includes(':'), 'password is stored hashed');
  assert.ok(!JSON.stringify(saved).includes('demo123'));
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
