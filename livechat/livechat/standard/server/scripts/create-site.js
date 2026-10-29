// Usage: node scripts/create-site.js "Client Name" [password] [allowed-origin ...]
// Creates a client site in the data file and prints its key, password and embed snippet.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const [name, passwordArg, ...origins] = process.argv.slice(2);
if (!name) {
  console.error('שימוש: node scripts/create-site.js "שם הלקוח" [סיסמה] [אתר-מותר ...]');
  process.exit(1);
}

const dataFile = process.env.DATA_FILE || path.join(here, '..', 'data.json');
const password = passwordArg || crypto.randomBytes(9).toString('base64url');
if (password.length < 8) {
  console.error('הסיסמה חייבת להכיל לפחות 8 תווים.');
  process.exit(1);
}
const store = createStore(dataFile);
let site;
try {
  site = store.createSite({ name, password, allowedOrigins: origins });
} catch (err) {
  console.error(`לא ניתן ליצור את האתר: ${err.message}`);
  process.exit(1);
}
store.flush();

const host = process.env.PUBLIC_URL || 'https://chat.yourdomain.com';
console.log(`נוצר אתר עבור "${name}"`);
console.log(`  מפתח האתר : ${site.key}`);
console.log(`  סיסמה     : ${password}   (למסור ללקוח להתחברות ללוח הבקרה)`);
console.log('\nקוד להטמעה באתר של הלקוח:');
console.log(`<script src="${host}/widget.js" data-site-key="${site.key}" async></script>`);
