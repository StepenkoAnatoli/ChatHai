const STOP = new Set([
  'the', 'and', 'for', 'are', 'you', 'your', 'what', 'how', 'can', 'does', 'have', 'with', 'this', 'that',
  'about', 'from', 'will', 'who', 'when', 'where', 'why', 'want', 'need', 'please', 'hello', 'thanks',
  // Hebrew question words and fillers that say nothing about the topic
  'האם', 'איך', 'כמה', 'אני', 'אתם', 'אתן', 'שלכם', 'שלי', 'אפשר', 'רוצה', 'רוצים', 'צריך', 'צריכה', 'בבקשה',
  'שלום', 'תודה', 'היי', 'לכם', 'זאת', 'מתי', 'איפה', 'למה', 'גם', 'יש', 'אין', 'מישהו', 'עולה',
]);

const HEBREW = /[֐-׿]/;

// Light Hebrew normalisation so "הפעילות" and "פעילות" (or "שעות" and "בשעות") compare equal:
// drop up to two one-letter prefixes (ו ה ב ל מ ש כ) and a plural ending (ים / ות).
function stem(word) {
  if (!HEBREW.test(word)) return word;
  let s = word;
  for (let i = 0; i < 2 && s.length > 3 && 'והבלמשכ'.includes(s[0]); i += 1) s = s.slice(1);
  if (s.length > 4 && (s.endsWith('ים') || s.endsWith('ות'))) s = s.slice(0, -2);
  return s;
}

function tokens(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);
}

// Emergency words for plumbers and electricians. Matched as substrings of the normalised text, so prefixes
// ("הנזילה", "בנזילה") and plurals are covered. Deliberately broad: a false alarm costs one extra alert,
// a missed emergency costs a customer's home.
const EMERGENCY = [
  'נזילה', 'נזילות', 'דליפה', 'דולף', 'הצפה', 'מוצף', 'מציף', 'פיצוץ', 'התפוצץ', 'צינור התפוצץ', 'שבר צינור',
  'מים בכל', 'מים בבית', 'ניצוצות', 'ניצוץ', 'קצר חשמלי', 'קצר בחשמל', 'קצר בלוח', 'התחשמל', 'חשמול', 'שריפה', 'שרפה', 'עשן', 'ריח גז', 'ריח שרוף',
  'אין חשמל', 'נפל החשמל', 'נשרף', 'חירום', 'דחוף', 'בדחיפות', 'urgent', 'emergency',
];

export function isEmergency(text) {
  const t = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ');
  return EMERGENCY.some((w) => t.includes(w));
}

// Returns the best matching FAQ entry, or null when nothing is close enough.
export function matchFaq(faq, text) {
  const asked = new Set(tokens(text));
  if (asked.size === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const item of faq || []) {
    const words = new Set(tokens(`${item.q} ${item.keywords || ''}`));
    if (words.size === 0) continue;
    let hits = 0;
    for (const w of asked) if (words.has(w)) hits += 1;
    const score = hits / Math.min(asked.size, words.size);
    if (hits > 0 && score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

// Optional AI answer. Only runs when ANTHROPIC_API_KEY is set.
// Returns a string, or null when the bot is unsure or the call fails.
export async function aiReply(site, messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const knowledge = (site.faq || []).map((f) => `Q: ${f.q}\nA: ${f.a}`).join('\n\n');
  const system =
    `You are the support chat assistant for "${site.name}". Answer only from the knowledge base below. ` +
    `Reply in the customer's language (Hebrew if unsure), in one to three short sentences. ` +
    `If the answer is not in the knowledge base, reply with exactly: NEED_HUMAN\n\nKnowledge base:\n${knowledge}`;
  const history = messages
    .slice(-10)
    .map((m) => ({ role: m.from === 'visitor' ? 'user' : 'assistant', content: m.text }));
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length) return null;
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
        max_tokens: 300,
        system,
        messages: history,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const text = (json.content || []).map((c) => c.text || '').join('').trim();
    if (!text || text.includes('NEED_HUMAN')) return null;
    return text;
  } catch {
    return null;
  }
}
