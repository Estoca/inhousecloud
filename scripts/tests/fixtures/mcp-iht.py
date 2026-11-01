"""Real iht-issued tokens, real ihc gateway, and real SDK MCP door inside Lima."""
import json
import os
from pathlib import Path
from types import SimpleNamespace

import httpx
from iht.config import Settings
from iht.keys import SigningKeys
from iht.mcp_auth import OAuthProvider
from iht.store import Store

settings = Settings()
store = Store(settings.data_dir / 'iht.db')
keys = SigningKeys(settings)
company = store.company(os.environ['ACME_ID'])
gateway = 'http://mcp.cloud.localhost'
store.set_instances(company.id, {'ihc_mcp': gateway, 'ihc': 'http://portal.cloud.localhost'}, 'ana@acme.test')
results = []

def rpc(url, token, method, params=None, expected=200):
    response = httpx.post(url + '/mcp', headers={'Authorization': 'Bearer ' + token,
        'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18'},
        json={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}}, timeout=60,
        verify=str(Path('tls.crt')))
    assert response.status_code == expected, f'HTTP {response.status_code}'
    return response.json() if expected == 200 else None

def check(name, fn):
    try:
        fn()
        results.append((name, 'PASS'))
    except Exception as exc:
        # No bearer or response bodies in diagnostics.
        results.append((name, 'FAIL: ' + type(exc).__name__))

for who, role in [('ana', 'owner'), ('bia', 'member')]:
    def direct(who=who, role=role):
        token = keys.instance_token(store.person(who + '@acme.test'), company, role, gateway)
        tools = rpc(gateway, token, 'tools/list')['result']['tools']
        names = {t['name'] for t in tools}
        assert 'ihc_list_apps' in names
        assert ('ihc_platform_status' in names) == (role == 'owner')
        result = rpc(gateway, token, 'tools/call', {'name': 'ihc_list_apps', 'arguments': {}})['result']
        assert not result.get('isError')
    check('MCP direct ' + who + ': role-filtered list and read', direct)

def wrong_aud():
    token = keys.instance_token(store.person('ana@acme.test'), company, 'owner', 'http://portal.cloud.localhost')
    rpc(gateway, token, 'tools/list', expected=401)
check('MCP wrong audience rejected (401)', wrong_aud)

def door():
    provider = OAuthProvider(settings, store)
    token = provider.issue(SimpleNamespace(client_id='lima-proof'), 'ana@acme.test', [], provider.resource).access_token
    result = rpc(settings.normalized_public_url, token, 'tools/call', {'name': 'ihc_list_tools', 'arguments': {}})['result']
    assert not result.get('isError')
    assert 'ihc_platform_status' in {t['name'] for t in result['structuredContent']['tools']}
    result = rpc(settings.normalized_public_url, token, 'tools/call', {'name': 'ihc_call',
        'arguments': {'tool': 'ihc_platform_status', 'arguments': {}}})['result']
    assert not result.get('isError')
    assert 'structuredContent' in result
check('MCP iht door: list and platform status', door)
print('\n| check | result |\n| --- | --- |')
for name, result in results:
    print(f'| {name} | {result} |')
Path('logs/mcp-summary.json').write_text(json.dumps(results, indent=2))
raise SystemExit(any(result != 'PASS' for _, result in results))
