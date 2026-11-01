"""Throwaway Google-shaped OIDC issuer. Never use outside the isolated SSO VM."""
import base64
import hashlib
import json
import os
import secrets
import time
from urllib.parse import urlencode

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse

app = FastAPI()
issuer = os.environ["MOCK_ISSUER"]
client = os.environ["IHT_GOOGLE_CLIENT_ID"]
secret = os.environ["IHT_GOOGLE_CLIENT_SECRET"]
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
jwk.update(kid="sso-test", use="sig", alg="RS256")
codes = {}
users = {
    "ana": ("ana@acme.test", "ana-original", "Ana", "acme.test"),
    "bia": ("bia@acme.test", "bia-original", "Bia", "acme.test"),
    "eve": ("eve@other.test", "eve-original", "Eve", "other.test"),
    "impostor": ("bia@acme.test", "bia-recycled", "Another Bia", "acme.test"),
}


@app.get("/.well-known/openid-configuration")
def discovery():
    return dict(issuer=issuer, authorization_endpoint=issuer + "/authorize",
                token_endpoint=issuer + "/token", jwks_uri=issuer + "/jwks",
                response_types_supported=["code"], subject_types_supported=["public"],
                id_token_signing_alg_values_supported=["RS256"],
                code_challenge_methods_supported=["S256"])


@app.get("/jwks")
def jwks():
    return {"keys": [jwk]}


@app.get("/authorize")
def authorize(request: Request):
    q = dict(request.query_params)
    account = q.get("test_user") or request.cookies.get("test_user")
    if (account not in users or q.get("client_id") != client
            or q.get("redirect_uri") != os.environ["IHT_PUBLIC_URL"] + "/oauth/callback"
            or q.get("response_type") != "code" or q.get("code_challenge_method") != "S256"
            or not q.get("nonce")):
        raise HTTPException(400, "Invalid test authorization")
    code = secrets.token_urlsafe(32)
    codes[code] = (q, account, time.time() + 60)
    return RedirectResponse(q["redirect_uri"] + "?" + urlencode(dict(code=code, state=q["state"])), 302)


@app.post("/token")
async def token(request: Request):
    f = await request.form()
    pending = codes.pop(f.get("code"), None)
    if not pending:
        raise HTTPException(400, "invalid_grant")
    q, account, expiry = pending
    challenge = base64.urlsafe_b64encode(hashlib.sha256(f.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
    if (expiry < time.time() or f.get("client_id") != client or f.get("client_secret") != secret
            or f.get("redirect_uri") != q["redirect_uri"] or challenge != q["code_challenge"]):
        raise HTTPException(400, "invalid_grant")
    email, sub, name, hd = users[account]
    now = int(time.time())
    claims = dict(iss=issuer, aud=client, sub=sub, email=email, email_verified=True,
                  hd=hd, name=name, nonce=q["nonce"], iat=now, exp=now + 300)
    return dict(access_token=secrets.token_urlsafe(32), token_type="Bearer", expires_in=300,
                id_token=jwt.encode(claims, key, algorithm="RS256", headers={"kid": "sso-test"}))
