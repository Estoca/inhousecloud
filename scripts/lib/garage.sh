# Garage, the S3-compatible server of the storage profile (docs/install-design.md).
# Sourced after common.sh by install.sh, occ-app.sh and smoke-tests.sh.
#
# Every call goes through `garage json-api ENDPOINT -` inside the container: the admin API
# over Garage's own RPC, authenticated by the RPC secret the container already has. The
# JSON payload travels on stdin, never on a command line; secret keys only come back on
# stdout into a variable and go straight to an env file.

garage_cid() {
  docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-occ}" \
    --filter "label=com.docker.compose.service=garage" | head -n 1
}

# garage_api ENDPOINT: JSON payload on stdin (`null` when there is none), JSON on stdout.
# On an error Garage prints `Error: <Code> (<status>): <message>` on stderr and exits 1.
garage_api() {
  docker exec -i -e RUST_LOG=warn "$GARAGE_CID" /garage json-api "$1" -
}

garage_need() {
  GARAGE_CID="$(garage_cid)"
  [ -n "$GARAGE_CID" ] || { fail "the Garage container is not running: the storage profile is off or the service failed (docker compose ps garage)"; return 1; }
}

# garage_healthy: every partition has quorum (`garage health` exits 1 before the layout).
garage_healthy() { docker exec -e RUST_LOG=warn "$GARAGE_CID" /garage health >/dev/null 2>&1; }

# garage_bytes SIZE: 100G, 500M, 2T or a plain number of bytes (powers of 1000, as Garage).
garage_bytes() {
  $PY -c 'import re,sys
m=re.fullmatch(r"\s*(\d+)\s*([KMGT]?)B?\s*", sys.argv[1], re.I)
if not m: sys.exit("bad size: %s (use 100G, 500M, 2T)" % sys.argv[1])
print(int(m.group(1)) * 1000 ** " KMGT".index((m.group(2) or " ").upper()))' "$1"
}

# garage_layout_init CAPACITY: a single-node layout (zone dc1, CAPACITY such as 100G).
# Idempotent: a layout that already gives this node a role is left alone, so a re-run
# never bumps the layout version or moves data.
garage_layout_init() {
  local cap layout version roles node i
  garage_need || return 1
  cap="$(garage_bytes "$1")" || return 1
  layout="$(printf null | garage_api GetClusterLayout)" || { fail "Garage: GetClusterLayout failed"; return 1; }
  version="$(printf '%s' "$layout" | jsonq get version 0)"
  roles="$(printf '%s' "$layout" | jsonq len roles)"
  if [ "${roles:-0}" -gt 0 ]; then
    ok "Garage layout version $version already assigns $roles node(s): unchanged"
  else
    node="$(printf null | garage_api GetClusterStatus | jsonq get nodes.0.id)"
    [ -n "$node" ] || { fail "Garage: no node id in GetClusterStatus"; return 1; }
    printf '{"roles":[{"id":"%s","zone":"dc1","capacity":%s,"tags":["occ"]}]}' "$node" "$cap" \
      | garage_api UpdateClusterLayout >/dev/null || { fail "Garage: UpdateClusterLayout failed"; return 1; }
    printf '{"version":%s}' "$((version + 1))" | garage_api ApplyClusterLayout >/dev/null \
      || { fail "Garage: ApplyClusterLayout failed"; return 1; }
    ok "Garage layout version $((version + 1)): node $(printf '%s' "$node" | cut -c1-16), zone dc1, capacity $1"
  fi
  for i in $(seq 1 30); do garage_healthy && return 0; sleep 1; done
  fail "Garage did not report a healthy cluster 30 s after the layout (docker compose exec garage /garage status)"
  return 1
}

# garage_app_bucket SLUG ENV_FILE PUBLIC_ENDPOINT: bucket app-SLUG and access key app-SLUG
# with read and write on that bucket only (not owner, no bucket creation), and the S3_*
# variables in ENV_FILE. Idempotent: the key that exists in Garage is kept and its secret
# rewritten to the env file; a key the env file has but Garage lost (a reset volume) is
# imported with the same id and secret, so the app keeps working. Never deletes a bucket
# or a key. Sets GARAGE_RESULT to "created", "kept", "restored" or "replaced" (a key deleted
# in Garage by hand: its id can never be reused).
garage_app_bucket() {
  local slug="$1" envf="$2" public="$3" name="app-$1" id sk found info bid err
  garage_need || return 1
  garage_healthy || { fail "Garage is up but has no healthy layout: re-run install.sh --apply --from optional_profiles"; return 1; }
  id="$(envfile get "$envf" S3_ACCESS_KEY_ID)"; sk="$(envfile get "$envf" S3_SECRET_ACCESS_KEY)"
  found="$(printf null | garage_api ListKeys | $PY -c 'import json,sys
keys=[k["id"] for k in json.load(sys.stdin) if k.get("name")==sys.argv[1]]
print(sys.argv[2] if sys.argv[2] in keys else (keys[0] if keys else ""))' "$name" "$id")" \
    || { fail "Garage: ListKeys failed"; return 1; }
  if [ -n "$found" ]; then
    info="$(printf '{"id":"%s","showSecretKey":true}' "$found" | garage_api GetKeyInfo)" || { fail "Garage: GetKeyInfo $name failed"; return 1; }
    GARAGE_RESULT=kept; [ "$found" = "$id" ] && [ -n "$sk" ] || GARAGE_RESULT=restored
    id="$found"; sk="$(printf '%s' "$info" | jsonq get secretAccessKey)"
  else
    if ! printf '%s' "$id" | grep -Eq '^GK[0-9a-f]{24}$' || ! printf '%s' "$sk" | grep -Eq '^[0-9a-f]{64}$'; then
      id="$($PY -c 'import secrets;print("GK"+secrets.token_hex(12))')"
      sk="$($PY -c 'import secrets;print(secrets.token_hex(32))')"
      GARAGE_RESULT=created
    else
      GARAGE_RESULT=restored
    fi
    err="$(mktemp "${TMPDIR:-/tmp}/occ-garage.XXXXXX")"
    for _ in 1 2; do
      # The env file first: a failure after this point is repaired by the next run.
      printf '%s' "$id" | envfile set "$envf" S3_ACCESS_KEY_ID
      printf '%s' "$sk" | envfile set "$envf" S3_SECRET_ACCESS_KEY
      printf '{"accessKeyId":"%s","secretAccessKey":"%s","name":"%s"}' "$id" "$sk" "$name" \
        | garage_api ImportKey >/dev/null 2>"$err" && break
      # Garage keeps a tombstone for a deleted key and never accepts its id again: the app
      # gets a new key (this deploy restarts it with the new env file).
      if [ "$GARAGE_RESULT" = restored ] && grep -q KeyAlreadyExists "$err"; then
        warn "key $id of $name was deleted in Garage and cannot be reused: issuing a new key"
        id="$($PY -c 'import secrets;print("GK"+secrets.token_hex(12))')"
        sk="$($PY -c 'import secrets;print(secrets.token_hex(32))')"
        GARAGE_RESULT=replaced
        continue
      fi
      fail "Garage: ImportKey $name: $(tail -n 1 "$err")"; rm -f "$err"; return 1
    done
    rm -f "$err"
  fi
  [ -n "$sk" ] || { fail "Garage returned no secret for key $name"; return 1; }
  printf '%s' "$id" | envfile set "$envf" S3_ACCESS_KEY_ID
  printf '%s' "$sk" | envfile set "$envf" S3_SECRET_ACCESS_KEY

  err="$(mktemp "${TMPDIR:-/tmp}/occ-garage.XXXXXX")"
  bid="$(printf '{"globalAlias":"%s"}' "$name" | garage_api GetBucketInfo 2>"$err" | jsonq get id)"
  if [ -z "$bid" ]; then
    grep -q NoSuchBucket "$err" || { fail "Garage: GetBucketInfo $name: $(tail -n 1 "$err")"; rm -f "$err"; return 1; }
    bid="$(printf '{"globalAlias":"%s"}' "$name" | garage_api CreateBucket 2>"$err" | jsonq get id)"
    [ -n "$bid" ] || { fail "Garage: CreateBucket $name: $(tail -n 1 "$err")"; rm -f "$err"; return 1; }
  fi
  rm -f "$err"
  printf '{"bucketId":"%s","accessKeyId":"%s","permissions":{"read":true,"write":true,"owner":false}}' "$bid" "$id" \
    | garage_api AllowBucketKey >/dev/null || { fail "Garage: AllowBucketKey $name failed"; return 1; }

  for kv in "S3_ENDPOINT=http://garage:3900" "S3_PUBLIC_ENDPOINT=$public" "S3_BUCKET=$name" \
            "S3_REGION=${GARAGE_S3_REGION:-garage}" "S3_FORCE_PATH_STYLE=true"; do
    printf '%s' "${kv#*=}" | envfile set "$envf" "${kv%%=*}"
  done
}
