#!/usr/bin/env python3
"""Minimal S3 client for the smoke tests (AWS Signature V4, path-style, stdlib only).

  s3.py put URL HOST BUCKET KEY   body on stdin; prints the HTTP status
  s3.py get URL HOST BUCKET KEY   prints the HTTP status; the body goes to fd 3 if open

URL is where the request is sent (http://127.0.0.1:80); HOST is the Host header that is
signed and sent (s3.harness.localhost), so the request goes through the proxy by its
public name. Credentials come from the environment, never the command line:
S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION.
"""
import datetime, hashlib, hmac, os, sys, urllib.error, urllib.parse, urllib.request


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
    req = urllib.request.Request(url.rstrip("/") + path, data=body if method == "PUT" else None, method=method)
    for h, v in headers.items():
        req.add_header(h, v)
    req.add_header("Authorization", "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s" % (access, scope, signed, signature))
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
