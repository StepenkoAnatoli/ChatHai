<div dir="rtl">

# צ׳אט חי: גרסה ללא תלויות

בלי `npm install`. דורש Node 22 ומעלה, וחיבור לאינטרנט בדפדפן (לוח הבקרה טוען את React ואת htm מ־unpkg).

```bash
node server.js     # http://localhost:3000
```

- לוח בקרה: <http://localhost:3000/> (התחברות לדוגמה: מפתח אתר `demo`, סיסמה `demo123`)
- "אתר לקוח" לדוגמה עם בועת הצ׳אט: <http://localhost:3000/demo>

הוספת לקוחות, קוד ההטמעה, תשובות של Claude, משתני סביבה, פריסה ומבנה הקבצים עובדים בדיוק כפי שמתואר ב־`../standard/README.md`. ההבדלים היחידים: כאן מריצים `node server.js` במקום `npm start`, והקבצים נמצאים ברמה העליונה (`server.js`, `store.js`, `bot.js`, `ws.js`, `public/`).

`ws.js` הוא מימוש WebSocket קטן שנכתב ביד (RFC 6455: מסגרות טקסט, ping/pong, סגירה, פיצול, מגבלה של 64KB להודעה). הוא נבדק, אבל למוצר לטווח ארוך החבילה `ws` ב־`../standard/` בטוחה יותר.

בפרודקשן, אחסן בעצמך את שלושת הסקריפטים של לוח הבקרה (או הוסף להם גיבוב `integrity`) במקום לטעון אותם מ־unpkg.

## בדיקות

```bash
npm test                # בדיקות שרת ובוט
npm run test:browser    # Chromium אמיתי; דורש pip install playwright && playwright install chromium
```

אם המחשב שלך לא מגיע ל־unpkg בזמן בדיקת הדפדפן, הגדר `REACT_BUNDLE` לחבילת React מקומית (ראה את ה־docstring ב־`test/browser/ui_test.py`).

</div>
