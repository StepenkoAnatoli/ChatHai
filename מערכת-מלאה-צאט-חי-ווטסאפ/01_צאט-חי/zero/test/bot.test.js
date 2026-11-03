import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { matchFaq, aiReply } from '../bot.js';
import { startServer } from '../server.js';
import { createStore } from '../store.js';

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

console.log('Running bot tests');

const faq = [
  { q: 'What are your opening hours?', a: 'Sunday to Thursday, 9-18.', keywords: 'hours open schedule' },
  { q: 'How much does shipping cost?', a: 'Free over 200 NIS.', keywords: 'delivery price' },
  { q: 'מה שעות הפעילות שלכם?', a: 'אנחנו פתוחים א׳-ה׳ 9:00-18:00.', keywords: 'שעות פתיחה' },
];

await test('matchFaq finds the right answer and ignores unrelated questions', () => {
  assert.equal(matchFaq(faq, 'when do you open? what are the hours')?.a, 'Sunday to Thursday, 9-18.');
  assert.equal(matchFaq(faq, 'do you offer delivery?')?.a, 'Free over 200 NIS.');
  assert.equal(matchFaq(faq, 'do you sell purple elephants'), null);
  // One shared word in a long, different question must NOT trigger a confident wrong answer.
  assert.equal(matchFaq(faq, 'what is the price of the red shoes in Haifa'), null);
  assert.equal(matchFaq(faq, '???'), null);
  assert.equal(matchFaq([], 'hours'), null);
});

await test('matchFaq works in Hebrew', () => {
  assert.match(matchFaq(faq, 'מתי אתם פתוחים? שעות פעילות')?.a || '', /פתוחים/);
});

await test('the default Hebrew FAQ answers natural Hebrew questions and ignores unrelated ones', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-he-'));
  const store = createStore(path.join(d, 'x.json'));
  const he = store.createSite({ name: 'חנות', password: 'password1', key: 'he' }).faq;
  const a = (q) => matchFaq(he, q)?.a || null;
  assert.match(a('מה שעות הפעילות שלכם?'), /9:00/);
  assert.match(a('עד כמה שעה אתם פתוחים?'), /9:00/);
  assert.match(a('כמה עולה משלוח?'), /משלוח חינם/);
  assert.match(a('יש דמי משלוח?'), /משלוח חינם/);
  assert.match(a('איך אפשר ליצור איתכם קשר?'), /support@example\.com/);
  assert.equal(a('האם אתם מוכרים פילים סגולים?'), null);
  assert.equal(a('מה המחיר של נעליים אדומות בחיפה'), null);
  store.flush();
  fs.rmSync(d, { recursive: true, force: true });
});

// Fake Anthropic API
let lastRequest = null;
let mode = 'ok';
let delay = 0;
let inFlight = 0;
let maxInFlight = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      if (mode === 'error') {
        res.writeHead(500);
        return res.end('{}');
      }
      const text = mode === 'unsure' ? 'NEED_HUMAN' : 'Yes, we ship abroad within 5 business days.';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    }, delay);
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
const site = { name: 'Demo Shop', faq };

await test('aiReply returns null when no API key is set', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(await aiReply(site, [{ from: 'visitor', text: 'hi' }]), null);
  assert.equal(lastRequest, null);
});

process.env.ANTHROPIC_API_KEY = 'test-key';

await test('aiReply sends a well-formed request and returns the model text', async () => {
  mode = 'ok';
  const messages = [
    { from: 'bot', text: 'Hi! Ask us anything.' },
    { from: 'visitor', text: 'Do you ship abroad?' },
  ];
  const answer = await aiReply(site, messages);
  assert.equal(answer, 'Yes, we ship abroad within 5 business days.');
  assert.equal(lastRequest.url, '/v1/messages');
  assert.equal(lastRequest.headers['x-api-key'], 'test-key');
  assert.equal(lastRequest.headers['anthropic-version'], '2023-06-01');
  assert.equal(lastRequest.body.model, 'claude-haiku-5-5');
  assert.match(lastRequest.body.system, /Demo Shop/);
  assert.match(lastRequest.body.system, /How much does shipping cost\?/);
  assert.equal(lastRequest.body.messages[0].role, 'user', 'history must start with a user turn');
  assert.deepEqual(lastRequest.body.messages, [{ role: 'user', content: 'Do you ship abroad?' }]);
});

await test('aiReply returns null when the model is unsure or the API fails', async () => {
  mode = 'unsure';
  assert.equal(await aiReply(site, [{ from: 'visitor', text: 'weird question' }]), null);
  mode = 'error';
  assert.equal(await aiReply(site, [{ from: 'visitor', text: 'anything' }]), null);
  assert.equal(await aiReply(site, [{ from: 'bot', text: 'only bot message' }]), null);
});

await test('CLAUDE_MODEL overrides the default model', async () => {
  mode = 'ok';
  process.env.CLAUDE_MODEL = 'claude-sonnet-5-5';
  await aiReply(site, [{ from: 'visitor', text: 'Do you ship abroad?' }]);
  assert.equal(lastRequest.body.model, 'claude-sonnet-5-5');
  delete process.env.CLAUDE_MODEL;
});

await test('server uses the AI answer instead of the fallback, and falls back when unsure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livechat-bot-'));
  const app = await startServer({ port: 0, dataFile: path.join(dir, 'data.json'), seedDemo: true });
  const ws = await new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${app.port}/ws?role=visitor&key=demo&vid=ai-visitor-0001`);
    w.onopen = () => resolve(w);
    w.onerror = () => reject(new Error('ws error'));
  });
  const inbox = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  const waitFor = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out');
  };

  mode = 'ok';
  ws.send(JSON.stringify({ type: 'message', text: 'Do you ship abroad?' }));
  const ai = await waitFor((m) => m.type === 'message' && m.message.from === 'bot');
  assert.match(ai.message.text, /ship abroad within 5 business days/);

  mode = 'unsure';
  ws.send(JSON.stringify({ type: 'message', text: 'Something nobody planned for' }));
  const fb = await waitFor((m) => m.type === 'message' && m.message.from === 'bot' && /נציג/.test(m.message.text));
  assert.ok(fb);
  ws.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('bot replies are serialised per conversation and never talk over a human', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livechat-race-'));
  const app = await startServer({ port: 0, dataFile: path.join(dir, 'data.json'), seedDemo: true });
  const login = await (
    await fetch(`http://127.0.0.1:${app.port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteKey: 'demo', password: 'demo123' }),
    })
  ).json();
  const open = (url) =>
    new Promise((resolve, reject) => {
      const w = new WebSocket(url);
      w.onopen = () => resolve(w);
      w.onerror = () => reject(new Error('ws error'));
    });
  const agent = await open(`ws://127.0.0.1:${app.port}/ws?role=agent&token=${login.token}`);
  const visitor = await open(`ws://127.0.0.1:${app.port}/ws?role=visitor&key=demo&vid=race-visitor-01`);
  let seen = [];
  visitor.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'message') seen.push(d.message.from);
  };

  // Two questions the FAQ cannot answer, sent back to back: the AI must be asked one at a time.
  mode = 'ok';
  delay = 300;
  maxInFlight = 0;
  visitor.send(JSON.stringify({ type: 'message', text: 'First thing the faq lacks' }));
  visitor.send(JSON.stringify({ type: 'message', text: 'Second thing the faq lacks' }));
  await sleep(1100);
  assert.equal(maxInFlight, 1, 'AI calls for one conversation must not overlap');
  assert.equal(seen.filter((f) => f === 'bot').length, 2);

  // A person answers while the AI is still thinking: the bot must stay silent afterwards.
  seen = [];
  delay = 600;
  visitor.send(JSON.stringify({ type: 'message', text: 'Third thing the faq lacks' }));
  await sleep(150);
  agent.send(JSON.stringify({ type: 'reply', convId: 'demo:race-visitor-01', text: 'Human here, I got this.' }));
  await sleep(1200);
  assert.ok(seen.includes('agent'), 'visitor should see the human reply');
  assert.ok(!seen.includes('bot'), `bot talked over the human: ${seen.join(',')}`);

  delay = 0;
  agent.close();
  visitor.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

fake.close();
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
