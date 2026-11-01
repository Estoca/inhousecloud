"""Real browser journeys and independent Authentik API assertions, inside Lima."""
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit

import httpx
from playwright.sync_api import sync_playwright, TimeoutError as BrowserTimeout
from iht.store import Store
from iht.oidc import Identity

ROOT = Path.cwd()


def env(key):
    return subprocess.check_output([
        'python3', 'ihc/scripts/lib/envfile.py', 'get', str(ROOT / 'cloud/.env'), key
    ], text=True).strip()


api = httpx.Client(base_url=f'http://127.0.0.1:{env("AUTHENTIK_LOCAL_PORT")}/api/v3/',
                   headers={'Authorization': 'Bearer ' + env('AUTHENTIK_BOOTSTRAP_TOKEN')}, timeout=30)
ids = json.loads((ROOT / 'identities.json').read_text())
store = Store(ROOT / 'data/iht.db')
# Restore Bia's original fixture membership after a previous --reuse run's
# recycled-address scenario. person_ids remain stable, just as in the product.
store.sign_in(Identity('bia@acme.test', 'Bia', 'google', 'bia-original', 'acme.test'), 1)
store.join_by_domain('bia@acme.test', 'acme.test')
store._q("UPDATE members SET role='member' WHERE company_id=? AND email='bia@acme.test'", (os.environ['ACME_ID'],))
results = []


def request(method, path, **kwargs):
    r = api.request(method, path, **kwargs)
    assert r.is_success, f'Authentik API {method} {path}: {r.status_code}'
    return r.json() if r.content else None


def users(email):
    return request('GET', 'core/users/', params={'email': email})['results']


def membership(who, expected):
    found = [u for u in users(f'{who}@acme.test') if u['username'] == 'iht-' + ids[who]]
    assert len(found) == 1, f'{who}: expected one source user, found {len(found)}'
    u = found[0]
    groups = {g['name'] for g in u['groups_obj']}
    assert groups == expected, f'{who}: groups {groups}, expected {expected}'
    assert not u['is_superuser'], f'{who} unexpectedly has Authentik superuser privileges'
    return u


def journey(browser, who, allowed=True):
    context = browser.new_context(ignore_https_errors=True)
    context.add_cookies([{'name': 'test_user', 'value': who, 'url': os.environ['MOCK_ISSUER']}])
    page = context.new_page()
    # Fail closed if a fixture accidentally advertises a real provider or website.
    allowed_hosts = {'portal.cloud.localhost', 'auth.cloud.localhost', urlsplit(os.environ['IHT_PUBLIC_URL']).hostname}
    context.route('**/*', lambda route: route.continue_() if urlsplit(route.request.url).hostname in allowed_hosts else route.abort())
    visited = []
    page.on('request', lambda req: visited.append(req.url) if req.is_navigation_request() else None)
    try:
        page.goto('http://portal.cloud.localhost', wait_until='domcontentloaded')
        # Authentik automatically follows a sole source when no local fields are
        # offered. Still support a version which renders its source button.
        try:
            page.wait_for_url(os.environ['IHT_PUBLIC_URL'] + '/**', timeout=5000)
        except BrowserTimeout:
            page.get_by_role('link', name='inhouse.technology', exact=False).click(timeout=30000)
        if allowed:
            page.get_by_role('link', name='Google', exact=False).click(timeout=30000)
        else:
            # Authentik sends a failed source login back to its default flow;
            # with a sole source it may automatically retry. Observe the real
            # callback response, then close the page to stop those retries.
            with page.expect_response(lambda r: '/source/oauth/callback/inhouse-technology/' in r.url
                                      and 'error=access_denied' in r.url, timeout=30000) as denied:
                page.get_by_role('link', name='Google', exact=False).click(timeout=30000, no_wait_after=True)
            assert denied.value.status in (302, 400, 403)
            page.close()
        if allowed:
            page.wait_for_url('http://portal.cloud.localhost/**', timeout=60000)
            assert 'portal.cloud.localhost' == urlsplit(page.url).hostname
            me = context.request.get('http://auth.cloud.localhost/api/v3/core/users/me/').json()
            username = me['user']['username']
            if who in ids:
                assert username == 'iht-' + ids[who], f'{who}: wrong session user'
            assert any('/authorize?' in url for url in visited), 'mock authorization not visited'
            assert any('/oidc/authorize?' in url for url in visited), 'iht authorization not visited'
            return username
        me = context.request.get('http://auth.cloud.localhost/api/v3/core/users/me/')
        assert me.status == 403, 'denied user obtained an Authentik session'
    except Exception:
        if not page.is_closed():
            page.screenshot(path=str(ROOT / 'logs' / f'{who}-failure.png'), full_page=True)
            (ROOT / 'logs' / f'{who}-failure.txt').write_text(page.locator('body').inner_text())
        # URLs may contain authorization codes, so only report the current path.
        print(f'Browser failure ({who}) at {urlsplit(page.url).path}', flush=True)
        raise
    finally:
        context.close()


def recovery(browser, username, password, allowed):
    context = browser.new_context()
    page = context.new_page()
    try:
        page.goto('http://auth.cloud.localhost/if/flow/ihc-local-recovery/')
        page.get_by_label('Username', exact=False).fill(username)
        page.get_by_label('Password', exact=True).fill(password)
        page.get_by_role('button', name='Log in', exact=False).click()
        if allowed:
            page.wait_for_url('**/if/user/**', timeout=30000)
        else:
            # A failed policy skips the login stage in this pinned version.
            # The flow completes without a session and returns to normal login.
            page.wait_for_url(lambda url: '/if/flow/ihc-local-recovery/' not in url, timeout=30000)
        me = context.request.get('http://auth.cloud.localhost/api/v3/core/users/me/')
        if allowed:
            assert me.status == 200 and me.json()['user']['username'] == username
        else:
            assert me.status == 403, 'ordinary local user bypassed iht'
    except Exception:
        (ROOT / 'logs' / 'recovery-failure.txt').write_text(page.locator('body').inner_text())
        page.screenshot(path=str(ROOT / 'logs' / 'recovery-failure.png'), full_page=True)
        raise
    finally:
        context.close()


def check(name, action):
    try:
        action()
        results.append((name, 'PASS'))
        print(f'PASS: {name}', flush=True)
    except Exception as exc:
        results.append((name, 'FAIL'))
        print(f'FAIL: {name}: {type(exc).__name__}: {exc}', flush=True)


with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--no-sandbox'])
    def login(who, expected):
        journey(browser, who)
        membership(who, expected)

    check('a. owner login; admin and users groups', lambda: login('ana', {'ihc-admins', 'ihc-users'}))
    check('b. member login; only users group', lambda: login('bia', {'ihc-users'}))

    def refused():
        journey(browser, 'eve', False)
        assert not users('eve@other.test'), 'other-company user enrolled in Authentik'
    check('c. other company refused; no Authentik user', refused)

    def promotion():
        store._q("UPDATE members SET role='owner' WHERE company_id=? AND email='bia@acme.test'", (os.environ['ACME_ID'],))
        login('bia', {'ihc-admins', 'ihc-users'})
    check('e1. promotion follows next login', promotion)

    def demotion():
        store._q("UPDATE members SET role='member' WHERE company_id=? AND email='bia@acme.test'", (os.environ['ACME_ID'],))
        login('bia', {'ihc-users'})
    check('e2. demotion follows next login', demotion)

    check('f1. akadmin recovery', lambda: recovery(browser, 'akadmin', env('AUTHENTIK_BOOTSTRAP_PASSWORD'), True))

    def local_denied():
        import secrets
        password = secrets.token_urlsafe(32)
        existing = request('GET', 'core/users/', params={'username': 'sso-local'})['results']
        user = existing[0] if existing else request('POST', 'core/users/', json={
            'username': 'sso-local', 'name': 'Local test', 'email': 'local@acme.test', 'is_active': True})
        request('POST', f'core/users/{user["pk"]}/set_password/', json={'password': password})
        recovery(browser, 'sso-local', password, False)
    check('f2. ordinary local user refused recovery', local_denied)

    def restart():
        compose = ['docker', 'compose', '--project-directory', str(ROOT / 'cloud'),
                   '-f', str(ROOT / 'cloud/compose.yml')]
        source = request('GET', 'sources/oauth/inhouse-technology/')
        # The pinned OAuth serializer requires these even on a partial update.
        request('PATCH', 'sources/oauth/inhouse-technology/', json={
            'name': 'SSO restart probe', **{k: source[k] for k in (
                'authorization_url', 'access_token_url', 'profile_url')}})
        subprocess.run(compose + ['stop', 'authentik-worker'], check=True)
        # Change the file while the watcher is stopped: startup discovery must
        # notice the new hash and restore this deliberately drifted attribute.
        with (ROOT / 'cloud/authentik/blueprints/iht.yaml').open('a') as out:
            out.write(f'\n# Restart probe {time.time_ns()}\n')
        subprocess.run(compose + ['restart', 'authentik-server', 'authentik-worker'], check=True)
        for _ in range(120):
            try:
                r = api.get('sources/oauth/inhouse-technology/')
                if r.is_success and r.json()['name'] == 'inhouse.technology':
                    break
            except httpx.HTTPError:
                pass
            time.sleep(2)
        else:
            raise AssertionError('Startup discovery did not reapply the mounted blueprint')
        bp = request('GET', 'managed/blueprints/')['results']
        assert any(b['path'] == 'custom/iht.yaml' and b['status'] == 'successful' for b in bp)
        login('ana', {'ihc-admins', 'ihc-users'})
        login('bia', {'ihc-users'})
    check('g. restart; blueprint reapplies; owner/member login', restart)

    def takeover():
        before = membership('bia', {'ihc-users'})['pk']
        # iht first revokes the recycled address's old membership. Verify that
        # rejection, then explicitly admit the new identity as a fresh member to
        # exercise Authentik's identifier matching with two equal email claims.
        journey(browser, 'impostor', False)
        store.join_by_domain('bia@acme.test', 'acme.test')
        username = journey(browser, 'impostor')
        assert username != 'iht-' + ids['bia'], 'different upstream subject inherited Bia session'
        original = request('GET', f'core/users/{before}/')
        assert original['username'] == 'iht-' + ids['bia']
        assert len(users('bia@acme.test')) == 2, 'expected two separate source identities'
    check('d. same email/different subject cannot inherit Bia', takeover)
    browser.close()

print('\n| check | result |\n| --- | --- |')
results.sort()
for name, result in results:
    print(f'| {name} | {result} |')
(ROOT / 'logs/summary.json').write_text(json.dumps(results, indent=2))
raise SystemExit(any(result != 'PASS' for _, result in results))
