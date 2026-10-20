#!/usr/bin/env python3
"""Minimal S3 client for the smoke tests (AWS Signature V4, path-style, stdlib only).

  s3.py put URL HOST BUCKET KEY   body on stdin; prints the HTTP status
  s3.py get URL HOST BUCKET KEY   prints the HTTP status; the body goes to fd 3 if open

URL is where the request is sent (http://127.0.0.1:80); HOST is the Host header that is
signed and sent (s3.cloud.localhost), so the request goes through the proxy by its
public name. Credentials come from the environment, never the command line:
S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION. With an https URL (TLS internal), the
connection goes to URL's address with HOST as the TLS server name, and the certificate is
verified against OCC_CA_FILE.
"""
import datetime, hashlib, hmac, http.client, os, socket, ssl, sys, urllib.error, urllib.parse, urllib.request


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS to a fixed address, with the public name as SNI and for the certificate check."""

    def __init__(self, addr, port, server_name, context, timeout):
        super().__init__(addr, port, context=context, timeout=timeout)
        self.server_name = server_name

    def connect(self):
        sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.server_name)


def sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def request(method, url, host, bucket, key, body=b""):
    access, secret = os.environ["S3_ACCESS_KEY_ID"], os.environ["S3_SECRET_ACCESS_KEY"]
    region = os.environ.get("S3_REGION", "garage")
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    path = "/%s/%s" % (urllib.parse.quote(bucket), urllib.parse.quote(key))
    payload = hashlib.sha256(body).hexdigest()
    headers = {"host": host, "x-amz-content-sha256": payload, "x-amz-date": amz_date}
    signed = ";".join(sorted(headers))
    canonical = "\n".join([method, path, "", "".join("%s:%s\n" % (k, headers[k]) for k in sorted(headers)), signed, payload])
    scope = "%s/%s/s3/aws4_request" % (day, region)
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    k = sign(sign(sign(sign(("AWS4" + secret).encode(), day), region), "s3"), "aws4_request")
    signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    auth = "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s" % (access, scope, signed, signature)
    u = urllib.parse.urlsplit(url)
    if u.scheme == "https":
        ctx = ssl.create_default_context(cafile=os.environ.get("OCC_CA_FILE") or None)
        c = PinnedHTTPSConnection(u.hostname, u.port or 443, host, ctx, 15)
        try:
            c.request(method, path, body=body if method == "PUT" else None, headers=dict(headers, Authorization=auth))
            r = c.getresponse()
            return r.status, r.read()
        except OSError:
            return 0, b""
        finally:
            c.close()
    req = urllib.request.Request(url.rstrip("/") + path, data=body if method == "PUT" else None, method=method)
    for h, v in headers.items():
        req.add_header(h, v)
    req.add_header("Authorization", auth)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except OSError:
        return 0, b""


def main():
    if len(sys.argv) != 6 or sys.argv[1] not in ("put", "get"):
        sys.exit(__doc__)
    cmd, url, host, bucket, key = sys.argv[1:]
    body = sys.stdin.buffer.read() if cmd == "put" else b""
    status, out = request(cmd.upper(), url, host, bucket, key, body)
    if cmd == "get" and status == 200:
        try:
            os.write(3, out)
        except OSError:
            pass
    print(status)


if __name__ == "__main__":
    main()
