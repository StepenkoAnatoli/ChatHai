"""Real-browser test: agent dashboard in one context, visitor widget in another, plus a second
"client website" on another origin. Needs: `npm run setup && npm run build`, and
`pip install playwright && playwright install chromium`. Run from the project root:
  python3 test/browser/ui_test.py
SHOTS=/some/dir saves screenshots there (default: system temp dir).
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import http.server
import threading
import urllib.request

from playwright.sync_api import expect, sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
BUNDLE = os.environ.get('REACT_BUNDLE')
SERVER_CWD = os.path.abspath(os.environ.get('SERVER_CWD', ROOT))
SERVER_FILE = os.environ.get('SERVER_FILE', 'server/index.js')
SHOTS = os.environ.get('SHOTS', tempfile.gettempdir())
SHIM = os.path.join(HERE, 'htm-shim.js')
PORT = 4177
BASE = f'http://127.0.0.1:{PORT}'

SLOW_PORT = PORT + 1
tmp = tempfile.mkdtemp(prefix='livechat-ui-')
server = None


def start_server():
    global server
    server = subprocess.Popen(
        ['node', SERVER_FILE],
        cwd=SERVER_CWD,
        env={**os.environ, 'PORT': str(PORT), 'DATA_FILE': os.path.join(tmp, 'data.json')},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    for _ in range(100):
        try:
            urllib.request.urlopen(BASE + '/api/site-config?key=demo', timeout=1)
            return
        except Exception:
            time.sleep(0.1)
    server.kill()
    sys.exit('server did not start')


def stop_server():
    server.terminate()
    try:
        server.wait(timeout=5)
    except Exception:
        server.kill()


class SlowPage(http.server.BaseHTTPRequestHandler):
    """A separate client website. Its widget <script> sits in <head> and the <body> arrives 1.2 s later,
    so the widget runs while document.body does not exist yet (and on a different origin than the chat server)."""

    def do_GET(self):
        self.send_response(200)
        self.send_header('content-type', 'text/html; charset=utf-8')
        self.end_headers()
        head = (
            '<!doctype html><html><head><meta charset="utf-8"><title>Client site</title>'
            f'<script src="{BASE}/widget.js" data-site-key="demo" async></script></head>'
        )
        self.wfile.write(head.encode())
        self.wfile.flush()
        time.sleep(1.2)
        self.wfile.write(b'<body><h1>Client website</h1></body></html>')

    def log_message(self, *args):
        pass


start_server()
slow = http.server.ThreadingHTTPServer(('127.0.0.1', SLOW_PORT), SlowPage)
threading.Thread(target=slow.serve_forever, daemon=True).start()

errors = []
passed = 0


def step(name):
    global passed
    passed += 1
    print(f'  ok   {name}')


def route_cdn(route):
    url = route.request.url
    if 'react-dom@' in url:
        route.fulfill(body='', content_type='application/javascript')
    elif 'react@' in url:
        route.fulfill(path=BUNDLE, content_type='application/javascript')
    elif 'htm@' in url:
        route.fulfill(path=SHIM, content_type='application/javascript')
    else:
        route.continue_()


def watch(page, label):
    def on_console(m):
        if m.type not in ('error', 'warning'):
            return
        url = m.location.get('url', '')
        # Deliberate failures: the wrong-password login (401) and the mistyped website address (400).
        if '401' in m.text and url.endswith('/api/login'):
            return
        if '400' in m.text and url.endswith('/api/settings'):
            return
        errors.append(f'{label} console.{m.type}: {m.text} ({m.location.get("url", "")})')

    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    page.on('console', on_console)


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        agent_ctx = browser.new_context(viewport={'width': 1200, 'height': 760})
        if BUNDLE:
            agent_ctx.route('https://unpkg.com/**', route_cdn)
        visitor_ctx = browser.new_context(viewport={'width': 390, 'height': 760})

        agent = agent_ctx.new_page()
        visitor = visitor_ctx.new_page()
        watch(agent, 'agent')
        watch(visitor, 'visitor')

        print('Running browser tests')

        # 1. login
        agent.goto(BASE + '/')
        agent.get_by_label('סיסמה').fill('wrong')
        agent.get_by_label('מפתח האתר').fill('demo')
        agent.get_by_role('button', name='התחברות').click()
        expect(agent.get_by_text('מפתח האתר או הסיסמה שגויים')).to_be_visible()
        agent.get_by_label('סיסמה').fill('demo123')
        agent.get_by_role('button', name='התחברות').click()
        expect(agent.locator('.top h2')).to_have_text('חנות הדגמה')
        expect(agent.get_by_text('אין שיחות עדיין.')).to_be_visible()
        step('dashboard login (bad password rejected, good password works)')

        # 2. visitor opens widget, asks FAQ question
        visitor.goto(BASE + '/demo')
        visitor.locator('button.bubble').click()
        expect(visitor.get_by_text('אפשר לשאול אותנו כל דבר על חנות הדגמה')).to_be_visible()
        expect(visitor.get_by_text('השיחה נשמרת אצל בעל האתר')).to_be_visible()  # privacy note under the input
        visitor.get_by_placeholder('כתבו הודעה').fill('מה שעות הפעילות?')
        visitor.get_by_placeholder('כתבו הודעה').press('Enter')
        expect(visitor.get_by_text('ימים א׳–ה׳')).to_be_visible()
        step('widget loads, greets, and the bot answers a FAQ question')

        # 3. agent sees the conversation live
        item = agent.locator('.item').first
        expect(item).to_contain_text('מבקר')
        item.click()
        expect(agent.locator('.msg.visitor')).to_have_text('מה שעות הפעילות?')
        expect(agent.locator('.msg.bot').first).to_contain_text('ימים א׳–ה׳')
        step('dashboard shows the new conversation and its messages in real time')

        # 4. unknown question -> fallback + needs-human flag
        visitor.get_by_placeholder('כתבו הודעה').fill('האם אתם מוכרים פילים סגולים?')
        visitor.get_by_placeholder('כתבו הודעה').press('Enter')
        expect(visitor.get_by_text('נציג יחזור אליך')).to_be_visible()
        expect(agent.locator('.item .pill.human')).to_have_text('דורש התייחסות')
        step('unknown question gets the fallback and is flagged "Needs you"')

        # 5. agent replies
        agent.get_by_placeholder('כתבו תשובה').fill('Hi, this is Dana. Let me check for you.')
        agent.get_by_role('button', name='שליחה').click()
        expect(visitor.locator('.m.agent')).to_have_text('Hi, this is Dana. Let me check for you.')
        expect(agent.locator('.chat-head .pill.human')).to_have_text('אתם מטפלים בשיחה')
        step('agent reply reaches the visitor and takes over from the bot')

        # 6. unread badge on closed widget
        visitor.locator('button.close').click()
        agent.get_by_placeholder('כתבו תשובה').fill('Are you still there?')
        agent.get_by_role('button', name='שליחה').click()
        expect(visitor.locator('.badge')).to_have_text('1')
        step('closed widget shows an unread badge')

        # 7. visitor reply raises unread in dashboard title
        visitor.locator('button.bubble').click()
        visitor.get_by_placeholder('כתבו הודעה').fill('כן, עדיין כאן')
        visitor.get_by_placeholder('כתבו הודעה').press('Enter')
        expect(agent.locator('.msg.visitor').last).to_have_text('כן, עדיין כאן')
        step('visitor messages appear in the open conversation')

        # 7b. HTML typed by a visitor is displayed as text everywhere, never executed
        payload = '<img src=x onerror="window.__xss=1"><b>not bold</b>'
        visitor.get_by_placeholder('כתבו הודעה').fill(payload)
        visitor.get_by_placeholder('כתבו הודעה').press('Enter')
        expect(agent.locator('.msg.visitor').last).to_have_text(payload)
        expect(visitor.locator('.m.visitor').last).to_have_text(payload)
        expect(agent.locator('.msg img, .msg b, .item .last img, .item .last b')).to_have_count(0)
        expect(visitor.locator('.m img, .m b')).to_have_count(0)
        assert agent.evaluate('window.__xss') is None and visitor.evaluate('window.__xss') is None
        step('HTML typed by a visitor is shown as plain text in the widget and the dashboard')

        # 8. desktop + mobile screenshots
        agent.screenshot(path=os.path.join(SHOTS, 'agent-desktop.png'))
        visitor.screenshot(path=os.path.join(SHOTS, 'widget-mobile.png'))

        # 8b. a page reload must not show old messages as unread
        visitor.reload()
        expect(visitor.locator('.m', has_text='כן, עדיין כאן')).to_have_count(1)  # history has arrived
        expect(visitor.locator('.badge')).to_be_hidden()
        step('reloading the page does not show old messages as unread')

        agent.get_by_placeholder('כתבו תשובה').fill('Ping while you were away')
        agent.get_by_role('button', name='שליחה').click()
        expect(visitor.locator('.badge')).to_have_text('1')
        visitor.reload()
        expect(visitor.locator('.m', has_text='Ping while you were away')).to_have_count(1)
        expect(visitor.locator('.badge')).to_have_text('1')
        visitor.locator('button.bubble').click()
        expect(visitor.locator('.badge')).to_be_hidden()
        visitor.reload()
        expect(visitor.locator('.m', has_text='Ping while you were away')).to_have_count(1)
        expect(visitor.locator('.badge')).to_be_hidden()
        step('a reply that arrived while the page was closed stays unread until opened, then counts as read')

        # 9. resolve
        agent.get_by_role('button', name='סיום טיפול').click()
        expect(agent.get_by_text('אין שיחות עדיין.')).to_be_visible()
        agent.locator('.filter select').select_option('closed')
        expect(agent.locator('.item')).to_have_count(1)
        step('resolving moves the conversation to the Resolved filter')

        # 10. reload keeps the session
        agent.reload()
        expect(agent.locator('.top h2')).to_have_text('חנות הדגמה')
        agent.locator('.filter select').select_option('all')
        expect(agent.locator('.item')).to_have_count(1)
        step('page reload keeps the login and conversation history')

        # 11. settings: snippet, edit greeting + FAQ, save
        agent.get_by_role('button', name='הגדרות').click()
        expect(agent.locator('code.snippet')).to_contain_text('data-site-key="demo"')
        expect(agent.locator('code.snippet')).to_contain_text('/widget.js')
        agent.get_by_label('ברכה למבקרים חדשים').fill('ברוכים הבאים לחנות הבדיקה!')
        agent.get_by_label('מייל להתראות').fill('owner@example.com')
        agent.get_by_role('button', name='הוספת שאלה').click()
        rows = agent.locator('.faq-row')
        last = rows.last
        last.locator('input[type=text]').first.fill('האם אתם עוטפים למתנה?')
        last.locator('textarea').fill('כן, עטיפת מתנה חינם בכל הזמנה.')
        last.locator('input[type=text]').nth(1).fill('מתנה לארוז אריזה עטיפה')
        agent.get_by_role('button', name='שמירת שינויים').click()
        expect(agent.get_by_text('נשמר')).to_be_visible()
        step('settings page shows embed snippet and saves greeting + FAQ')

        # 12. new visitor sees the updated greeting and new FAQ answer
        fresh = browser.new_context(viewport={'width': 390, 'height': 760}).new_page()
        watch(fresh, 'fresh visitor')
        fresh.goto(BASE + '/demo')
        fresh.locator('button.bubble').click()
        expect(fresh.get_by_text('ברוכים הבאים לחנות הבדיקה!')).to_be_visible()
        fresh.get_by_placeholder('כתבו הודעה').fill('אפשר לארוז מתנה להזמנה?')
        fresh.get_by_placeholder('כתבו הודעה').press('Enter')
        expect(fresh.get_by_text('עטיפת מתנה חינם')).to_be_visible()
        step('a new visitor gets the edited greeting and the new FAQ answer')

        # 12b. embedded on a different website, widget script in <head>, <body> arriving late
        client = browser.new_context(viewport={'width': 1000, 'height': 700}).new_page()
        watch(client, 'client site')
        client.goto(f'http://127.0.0.1:{SLOW_PORT}/')
        expect(client.locator('#livechat-host')).to_have_count(1)
        client.locator('button.bubble').click()
        expect(client.get_by_text('ברוכים הבאים לחנות הבדיקה!')).to_be_visible()
        expect(client.locator('.status')).to_be_hidden()  # connected over a cross-origin websocket
        step('widget works on another website, even when it runs before <body> exists')

        # 12c. allowed websites: a typo is rejected, a valid list is normalised and enforced
        agent.get_by_role('button', name='הגדרות').click()
        agent.get_by_label('אתרים מותרים').fill('shop.example')
        agent.get_by_role('button', name='שמירת שינויים').click()
        expect(agent.get_by_text('אינה כתובת אתר תקינה')).to_be_visible()
        agent.get_by_label('אתרים מותרים').fill(f'http://127.0.0.1:{SLOW_PORT}/')
        agent.get_by_role('button', name='שמירת שינויים').click()
        expect(agent.get_by_text('נשמר')).to_be_visible()

        blocked = browser.new_context(viewport={'width': 390, 'height': 700}).new_page()
        blocked.goto(BASE + '/demo')  # origin 127.0.0.1:PORT is not on the list
        blocked.locator('button.bubble').click()
        expect(blocked.get_by_text('מתחבר מחדש')).to_be_visible()
        expect(blocked.get_by_text('ברוכים הבאים לחנות הבדיקה!')).to_have_count(0)
        allowed = browser.new_context().new_page()
        allowed.goto(f'http://127.0.0.1:{SLOW_PORT}/')
        allowed.locator('button.bubble').click()
        expect(allowed.get_by_text('ברוכים הבאים לחנות הבדיקה!')).to_be_visible()

        agent.get_by_label('אתרים מותרים').fill('')
        agent.get_by_role('button', name='שמירת שינויים').click()
        expect(agent.get_by_text('נשמר')).to_be_visible()
        step('mistyped website is rejected; the listed website connects and any other website is blocked')

        # 13. mobile dashboard layout
        mobile = browser.new_context(viewport={'width': 390, 'height': 760})
        if BUNDLE:
            mobile.route('https://unpkg.com/**', route_cdn)
        m = mobile.new_page()
        watch(m, 'mobile agent')
        m.goto(BASE + '/')
        m.get_by_label('סיסמה').fill('demo123')
        m.get_by_label('מפתח האתר').fill('demo')
        m.get_by_role('button', name='התחברות').click()
        m.locator('.filter select').select_option('all')
        expect(m.locator('.item')).to_have_count(2)
        m.screenshot(path=os.path.join(SHOTS, 'agent-mobile-list.png'))
        m.locator('.item').first.click()
        expect(m.locator('.chat')).to_be_visible()
        expect(m.locator('.list')).to_be_hidden()
        m.screenshot(path=os.path.join(SHOTS, 'agent-mobile-chat.png'))
        m.get_by_role('button', name='חזרה').click()
        expect(m.locator('.list')).to_be_visible()
        step('mobile layout: list and chat switch correctly')

        # 14. sign out
        agent.get_by_role('button', name='התנתקות').click()
        expect(agent.get_by_role('button', name='התחברות')).to_be_visible()
        step('sign out returns to the login form')

        # 15. a server restart drops every login: the dashboard must notice and show the login form
        r_ctx = browser.new_context(viewport={'width': 1000, 'height': 700})
        if BUNDLE:
            r_ctx.route('https://unpkg.com/**', route_cdn)
        r = r_ctx.new_page()
        r.goto(BASE + '/')
        r.get_by_label('מפתח האתר').fill('demo')
        r.get_by_label('סיסמה').fill('demo123')
        r.get_by_role('button', name='התחברות').click()
        expect(r.locator('.top h2')).to_have_text('חנות הדגמה')
        for ctx in browser.contexts:  # pages left open would log their own (expected) connection errors
            if ctx is not r_ctx:
                ctx.close()
        stop_server()
        start_server()
        expect(r.get_by_role('button', name='התחברות')).to_be_visible(timeout=30000)
        step('after a server restart the dashboard returns to the login form instead of hanging')

        browser.close()
finally:
    stop_server()
    slow.shutdown()

if errors:
    print('\nBrowser console problems:')
    for e in errors:
        print('  ', e)
    sys.exit(1)
print(f'{passed} browser steps passed, no console errors')
