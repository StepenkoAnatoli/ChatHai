import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isEmergency } from '../server/bot.js';
import { createNotifier, normalizePhone } from '../server/notify.js';
import { startServer } from '../server/index.js';

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
console.log('Running emergency and WhatsApp alert tests');

await test('isEmergency catches natural Hebrew emergencies and ignores ordinary questions', () => {
  for (const t of ['יש לי נזילה במטבח', 'הצינור התפוצץ והמים בכל הבית', 'יוצאים ניצוצות מהשקע', 'אין חשמל בכל הדירה', 'יש ריח גז!', 'זה דחוף', 'קצר חשמלי בלוח']) {
    assert.equal(isEmergency(t), true, t);
  }
  for (const t of ['מה שעות הפעילות שלכם?', 'כמה עולה להחליף ברז?', 'אפשר לקבוע תור לשבוע הבא?', 'אשמח לפרטים בקצרה', 'מה החשמל שלכם עולה']) {
    assert.equal(isEmergency(t), false, t);
  }
});

await test('normalizePhone accepts Israeli formats and rejects typos', () => {
  assert.equal(normalizePhone('050-123 4567'), '972501234567');
  assert.equal(normalizePhone('+972501234567'), '972501234567');
  assert.equal(normalizePhone('972501234567'), '972501234567');
  assert.equal(normalizePhone('03-5551234'), '97235551234');
  for (const bad of ['', '12345', '050123', 'abc', '+1 415 555 2671', '0501234567890123']) assert.equal(normalizePhone(bad), '', bad);
});

const waCalls = [];
let waStatus = 200;
const waSrv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    waCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
    res.writeHead(waStatus, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((r) => waSrv.listen(0, '127.0.0.1', r));
const quiet = { error() {} };
const mk = (extra = {}) => createNotifier({ apiKey: '', from: '', waToken: 'tok', waPhoneId: '555', waTemplate: 'new_chat', waApiUrl: `http://127.0.0.1:${waSrv.address().port}/v1`, minGapMs: 60000, log: quiet, ...extra });

await test('WhatsApp alert uses the approved template, one variable, no newlines, to a normalised number', async () => {
  waCalls.length = 0;
  const n = mk();
  assert.equal(n.whatsappEnabled, true);
  const ok = await n.notify({ name: 'אינסטלציה\nכהן', notifyWhatsapp: '0501234567' }, { id: 'c1' }, 'יש נזילה\n\nבמטבח', { urgent: true });
  assert.equal(ok, true);
  const c = waCalls[0];
  assert.equal(c.url, '/v1/555/messages');
  assert.equal(c.auth, 'Bearer tok');
  assert.equal(c.body.to, '972501234567');
  assert.equal(c.body.type, 'template');
  assert.equal(c.body.template.name, 'new_chat');
  const text = c.body.template.components[0].parameters[0].text;
  assert.match(text, /^דחוף! /);
  assert.doesNotMatch(text, /[\n\t]/);
});

await test('urgent alerts are throttled separately from ordinary ones; failures do not consume the throttle', async () => {
  waCalls.length = 0;
  const n = mk();
  const site = { name: 's', notifyWhatsapp: '0501234567' };
  assert.equal(await n.notify(site, { id: 'c2' }, 'hello'), true);
  assert.equal(await n.notify(site, { id: 'c2' }, 'hello again'), false, 'ordinary repeat is throttled');
  assert.equal(await n.notify(site, { id: 'c2' }, 'נזילה', { urgent: true }), true, 'urgent is not hidden by the earlier ordinary alert');
  assert.equal(waCalls.length, 2);
  waStatus = 500;
  assert.equal(await n.notify(site, { id: 'c3' }, 'x'), false);
  waStatus = 200;
  assert.equal(await n.notify(site, { id: 'c3' }, 'x'), true, 'a failed send can be retried');
  assert.equal(await mk({ waToken: '' }).notify(site, { id: 'c4' }, 'x'), false, 'disabled: silent');
  assert.equal(await n.notify({ name: 's', notifyWhatsapp: '' }, { id: 'c5' }, 'x'), false, 'no number: silent');
});

await test('end to end: emergency gets the canned reply and an alert even with the dashboard open; repeats do not re-alert', async () => {
  waCalls.length = 0;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-emerg-'));
  const s = await startServer({ port: 0, dataFile: path.join(d, 'd.json'), seedDemo: true, notifier: mk() });
  const b = `http://127.0.0.1:${s.port}`;
  const call = async (p, opts) => {
    const r = await fetch(b + p, opts);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const tok = (await call('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteKey: 'demo', password: 'demo123' }) })).body.token;
  const auth = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
  const put = (body) => call('/api/settings', { method: 'PUT', headers: auth, body: JSON.stringify(body) });

  assert.equal((await put({ notifyWhatsapp: '12345' })).status, 400);
  const saved = await put({ notifyWhatsapp: '050-123-4567' });
  assert.equal(saved.body.notifyWhatsapp, '972501234567');
  assert.equal(saved.body.whatsappEnabled, true);
  assert.match(saved.body.emergencyReply, /101/);

  const agent = new WebSocket(`ws://127.0.0.1:${s.port}/ws?role=agent&token=${tok}`);
  const visitor = new WebSocket(`ws://127.0.0.1:${s.port}/ws?role=visitor&key=demo&vid=visitor-emerg1`);
  const got = [];
  const agentEvents = [];
  visitor.onmessage = (e) => got.push(JSON.parse(e.data));
  agent.onmessage = (e) => agentEvents.push(JSON.parse(e.data));
  await Promise.all([new Promise((r) => (agent.onopen = r)), new Promise((r) => (visitor.onopen = r))]);
  const settle = () => new Promise((r) => setTimeout(r, 300));

  visitor.send(JSON.stringify({ type: 'message', text: 'יש נזילה גדולה מתחת לכיור!' }));
  await settle();
  const botMsgs = () => got.filter((m) => m.type === 'message' && m.message.from === 'bot').map((m) => m.message.text);
  assert.equal(botMsgs().length, 1);
  assert.match(botMsgs()[0], /101/);
  assert.equal(waCalls.length, 1, 'alert sent although an agent is connected');
  assert.match(waCalls[0].body.template.components[0].parameters[0].text, /נזילה/);
  assert.ok(agentEvents.some((m) => m.conv?.urgent === true), 'dashboard sees the urgent flag');

  visitor.send(JSON.stringify({ type: 'message', text: 'והמים ממשיכים לזרום, הצינור התפוצץ' }));
  await settle();
  assert.equal(waCalls.length, 1, 'no second alert for the same emergency');
  assert.equal(botMsgs().filter((t) => /101/.test(t)).length, 1, 'no second canned reply');

  // a person answers: urgency clears
  const convId = agentEvents.find((m) => m.conv)?.conv.id;
  agent.send(JSON.stringify({ type: 'reply', convId, text: 'אני בדרך' }));
  await settle();
  assert.equal(s.store.data.conversations[convId].urgent, false);

  visitor.close();
  agent.close();
  await s.close();
  fs.rmSync(d, { recursive: true, force: true });
});

waSrv.close();
console.log(`${passed} passed`);
