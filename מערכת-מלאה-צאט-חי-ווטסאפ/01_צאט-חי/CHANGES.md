<div dir="rtl">

# סבבי סקירה ותיקונים (באנגלית, כפי שנכתבו)

הקובץ הזה נשאר באנגלית כי הוא יומן טכני. ראה בסופו את סעיפי הסבב השני והמעבר לעברית.

## Review pass 1: bugs found and fixed

I re-read all the code, reproduced each suspected problem with a script first, then fixed it in both versions and added a test that fails without the fix.

| # | Bug | Effect | Fix |
|---|---|---|---|
| 1 | The bot could answer after a human had taken over | While Claude was still thinking, a person replied, and then the bot posted its own answer on top | The bot re-checks for a human after the AI call, and bot replies for one chat now run one at a time, in order |
| 2 | Unread badge showed old messages after every page reload | A visitor who reloaded saw a red "2" with nothing new | The widget remembers the newest reply the visitor saw; only newer ones count. Replies that arrived while the page was closed stay unread until the chat is opened |
| 3 | Dashboard hung on "reconnecting" after a server restart | Logins live in memory, so the old one was dead, but the dashboard never found out | Every failed reconnect now checks the login and returns to the sign-in form |
| 4 | Login limit counted successful logins and used the proxy's address | Behind Caddy/nginx, 10 logins in 5 minutes from all your clients together would lock everyone out | Only failed attempts count, per client address (`TRUST_PROXY=1`) |
| 5 | Widget silently failed to appear if its script ran before `<body>` existed | Script in `<head>` plus a fast connection gave no chat and no visible error | The widget waits for the page body |
| 6 | A mistyped allowed website (`shop.example`) was dropped silently | An empty list means "allow every website", so a typo removed the protection. A trailing slash (`https://x.com/`) also blocked the client's own visitors | Entries are validated and normalised; invalid ones are rejected with a message |
| 7 | Message rate limit was per connection | A visitor (or script) could reconnect to reset it, which matters once Claude answers cost money | The limit is per conversation |
| 8 | Signing out did not end the session on the server | A copied token stayed valid for 12 hours | Sign out now invalidates the token and closes that agent's live connection |

Smaller changes: the demo site (`demo` / `demo123`) is no longer created when `NODE_ENV=production`; the chat input is 16px so iPhones do not zoom in; `create-site` now rejects short passwords and bad website addresses; the dashboard lists the 200 most recent conversations; the Vite build caches only hashed asset files forever.

## Things I checked and found fine
Each of these now has a test: HTML typed by a visitor is shown as text in the widget and the dashboard (browser test); the hand-written WebSocket handles all length encodings, fragmentation, ping/pong, oversize, unmasked, binary, split and coalesced frames, checked against the `ws` library as a reference (`test/ws-frames.test.js`); one client cannot see another's chats; static files cannot be escaped with `../` (`standard/`; `zero/` serves only a fixed list of files). Passwords are stored hashed (scrypt), never in plain text. By reading the code, the dashboard uses only React features that exist in 18, although I could only run it on React 19 here.

## Known limits (not bugs, but know them)
- Everything is one process and one JSON file. Fine for a handful of small clients; move to a database before you grow.
- The agent login token travels in the WebSocket URL. Make sure your proxy does not log full URLs (Caddy does not by default).
- Chats are stored in plain text and never deleted automatically.
- `create-site` writes the data file directly, so run it only while the server is stopped (use the admin endpoint on a running server).

## Review pass 2: crashes and abuse

| # | Problem | Effect | Fix |
|---|---|---|---|
| 9 | A WebSocket upgrade to a path like `//` or `//[` threw inside the upgrade handler | Any anonymous request could kill the whole server process | URL parsing is wrapped; the server answers `400` |
| 10 | A visitor or agent sent the JSON `null` (or a number/array) | `null.type` threw and the process crashed | One `parseMsg` helper rejects anything that is not a JSON object, used in all four message handlers; the hand-written WebSocket also catches handler errors and closes with 1011 |
| 11 | No limit per IP address | One address could open thousands of conversations or flood messages from many sockets | `IP_MESSAGES_PER_MINUTE` (120) and `IP_NEW_CONVERSATIONS_PER_HOUR` (30) |
| 12 | The dashboard could be embedded in another website | Clickjacking | `X-Frame-Options: DENY` and `frame-ancestors 'none'` on static pages |

## Hebrew conversion

Everything the people using it see is now Hebrew with right-to-left layout: the widget (panel direction, message sides, labels), both dashboards (`<html lang="he" dir="rtl">`, list divider flipped, `he-IL` times, "מבקר" as the visitor name), server error messages, the `create-site` output, the demo page, and the default FAQ / greeting / fallback for new sites. The bot has Hebrew stop words and the Claude system prompt answers in the visitor's language (Hebrew when unsure). All tests were updated and a new one checks that the default Hebrew FAQ answers natural Hebrew questions and ignores an unrelated one. Also fixed while checking screenshots: the widget's input could overflow its panel on narrow phones (`min-width: 0`).

Sites created before the conversion keep their old English greeting, fallback and FAQ in `data.json`; edit them in the dashboard's Settings tab or recreate the site.

Test totals after the Hebrew conversion: 22 end-to-end, 9 bot, 9 WebSocket frame and 19 browser steps, on both versions.

## Email alerts and privacy note

`notify.js` sends one email per conversation per 10 minutes (Resend HTTP API through `fetch`, no dependency) when the bot could not answer and no agent is connected. Per-site `notifyEmail` and `privacyNote` settings, both validated (address rejects CR/LF header injection). A failed send never affects the chat. Tested against a fake mail server, with mutation checks that the "agent online" and "bot could not help" conditions are what the test depends on. Totals: 23 end-to-end tests.

</div>
