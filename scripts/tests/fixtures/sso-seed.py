"""Seed only through the real iht store, never through an identity-provider API."""
import json
import os
from pathlib import Path
import secrets
import shlex

import yaml
from iht.store import Store
from iht.oidc import Identity

root = Path.cwd()
(root / "data").mkdir(exist_ok=True)
s = Store(root / "data/iht.db")
for who in ("ana", "bia", "eve"):
    domain = "other.test" if who == "eve" else "acme.test"
    s.sign_in(Identity(f"{who}@{domain}", who.title(), "google", f"{who}-original", domain), 1)
acme = s.create_company("Acme", "acme.test", "self", "ana@acme.test")
s.mark_proven(acme.id)
s.join_by_domain("bia@acme.test", "acme.test")
other = s.create_company("Other", "other.test", "self", "eve@other.test")
s.mark_proven(other.id)
client, secret = s.create_oidc_client(acme.id, "ihc test", [
    "http://auth.cloud.localhost/source/oauth/callback/inhouse-technology/"], "ana@acme.test")
bridge = os.environ["BRIDGE"]
env = dict(IHT_PUBLIC_URL=f"https://{bridge}:9443", IHT_DATA_DIR=str(root / "data"),
           IHT_GOOGLE_ISSUER=f"http://{bridge}:9081", MOCK_ISSUER=f"http://{bridge}:9081",
           IHT_GOOGLE_CLIENT_ID=secrets.token_hex(16), IHT_GOOGLE_CLIENT_SECRET=secrets.token_hex(32),
           IHC_IHT_CLIENT_SECRET=secret, ACME_ID=acme.id)
(root / "test.env").write_text("".join(f"{k}={shlex.quote(v)}\n" for k, v in env.items()))
(root / "test.env").chmod(0o600)
config = yaml.safe_load((root / "ihc/bootstrap/config.example.yaml").read_text())
config["install"]["directory"] = str(root / "cloud")
config["authentik"]["iht"].update(issuer=env["IHT_PUBLIC_URL"], client_id=client["client_id"])
config["admin"]["email"] = "ana@acme.test"
config["authentik"]["bootstrap_email"] = "ana@acme.test"
config["portal"]["super_admin_emails"] = ["ana@acme.test"]
(root / "config.yaml").write_text(yaml.safe_dump(config))
(root / "identities.json").write_text(json.dumps({who: s.person(f"{who}@acme.test")["id"] for who in ("ana", "bia")}))
