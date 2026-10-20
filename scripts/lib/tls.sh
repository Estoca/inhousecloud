# Internal TLS (TLS_MODE=internal): a CA of the installation's own and one wildcard
# certificate for *.BASE_DOMAIN, in <install-dir>/local/ca/. bash 3.2. Sourced, never
# executed. The caller sources common.sh first.
#
#   ca.key, ca.crt              the CA, 10 years, RSA 3072. Name-constrained to BASE_DOMAIN
#                               (and no IP address): installed on a device, it can vouch for
#                               names under BASE_DOMAIN and nothing else
#   wildcard.key, wildcard.crt  *.BASE_DOMAIN and BASE_DOMAIN, 397 days, RSA 2048; renewed
#                               on any install run when 30 days or less remain
#   domain                      the BASE_DOMAIN the CA was made for; another domain means a
#                               new CA (the constraint cannot be widened)
# Keys are 0600 and stay in local/ca, except the wildcard key, which the proxy also keeps
# (uploaded as a custom certificate). ca.crt is public: it is what devices install.

ca_dir() { printf '%s/local/ca' "$INSTALL_DIR"; }

# ossl ARGS...: openssl on the host, else the proxy image's (local/ca mounted at the same path).
ossl() {
  if have openssl; then openssl "$@"
  else docker run --rm -i -u "$(id -u):$(id -g)" -v "$(ca_dir):$(ca_dir)" -w "$(ca_dir)" --entrypoint openssl "$(env_get PROXY_IMAGE)" "$@"; fi
}

# ensure_internal_ca DOMAIN: the CA and the wildcard certificate exist, match DOMAIN and the
# certificate has more than 30 days left. Probes first; creates only what is missing.
ensure_internal_ca() {
  local domain="$1" d made="" serial
  d="$(ca_dir)"
  (umask 077; mkdir -p "$d"); chmod 700 "$d"
  if [ -s "$d/ca.key" ] && [ -s "$d/ca.crt" ] && [ "$(cat "$d/domain" 2>/dev/null)" != "$domain" ]; then
    warn "tls internal: the CA in $d was made for $(cat "$d/domain" 2>/dev/null || echo another domain); a new CA for $domain replaces it (devices must install the new ca.crt)"
    rm -f "$d/ca.key" "$d/ca.crt" "$d/wildcard.key" "$d/wildcard.crt"
  fi
  cat > "$d/ca.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
O = Open Company Cloud
CN = Open Company Cloud internal CA for $domain
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:$domain, excluded;IP:0.0.0.0/0.0.0.0, excluded;IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0
[v3_leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:*.$domain, DNS:$domain
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
  if [ ! -s "$d/ca.key" ] || [ ! -s "$d/ca.crt" ]; then
    rm -f "$d/wildcard.key" "$d/wildcard.crt"
    (umask 077; ossl genrsa -out "$d/ca.key" 3072 2>/dev/null) || return 1
    ossl req -x509 -new -key "$d/ca.key" -sha256 -days 3650 -config "$d/ca.cnf" -extensions v3_ca -out "$d/ca.crt" 2>/dev/null || return 1
    printf '%s\n' "$domain" > "$d/domain"
    made="CA"
  fi
  if [ ! -s "$d/wildcard.key" ] || [ ! -s "$d/wildcard.crt" ] || ! ossl x509 -checkend 2592000 -noout -in "$d/wildcard.crt" >/dev/null 2>&1; then
    serial="0x$($PY -c 'import secrets;print(secrets.token_hex(16))')"
    (umask 077; ossl genrsa -out "$d/wildcard.key" 2048 2>/dev/null) || return 1
    ossl req -new -key "$d/wildcard.key" -subj "/CN=*.$domain" -out "$d/wildcard.csr" 2>/dev/null || return 1
    ossl x509 -req -in "$d/wildcard.csr" -CA "$d/ca.crt" -CAkey "$d/ca.key" -set_serial "$serial" -days 397 -sha256 \
      -extfile "$d/ca.cnf" -extensions v3_leaf -out "$d/wildcard.crt" 2>/dev/null || return 1
    rm -f "$d/wildcard.csr"
    made="${made:+$made and }wildcard certificate"
  fi
  chmod 600 "$d/ca.key" "$d/wildcard.key"; chmod 644 "$d/ca.crt" "$d/wildcard.crt"
  ossl verify -CAfile "$d/ca.crt" "$d/wildcard.crt" >/dev/null 2>&1 || { fail "tls internal: $d/wildcard.crt does not verify against $d/ca.crt"; return 1; }
  if [ -n "$made" ]; then ok "tls internal: $made generated in $d (*.$domain, until $(ca_cert_end "$d/wildcard.crt"))"
  else ok "tls internal: CA and *.$domain certificate present in $d (until $(ca_cert_end "$d/wildcard.crt"))"; fi
}

ca_cert_end() { ossl x509 -enddate -noout -in "$1" 2>/dev/null | sed 's/^notAfter=//'; }
ca_fingerprint() { ossl x509 -fingerprint -sha256 -noout -in "$(ca_dir)/ca.crt" 2>/dev/null | sed 's/^.*=//'; }

# ca_install_help [INDENT]: the file and the per-OS commands a person runs on each device,
# printed by the handoff. ca.crt is public; the CA key never leaves the box.
ca_install_help() {
  local f="occ-ca.crt" i="${1:-    }"
  _out "${i}file:     $(ca_dir)/ca.crt (public). Copy it: scp $(id -un)@<this box>:$(ca_dir)/ca.crt $f"
  _out "${i}SHA-256:  $(ca_fingerprint)   (compare after copying)"
  _out "${i}macOS:    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain $f"
  _out "${i}Windows:  certutil -addstore -f Root $f   (administrator prompt)"
  _out "${i}Linux:    sudo cp $f /usr/local/share/ca-certificates/$f && sudo update-ca-certificates"
  _out "${i}iOS:      open the file on the device, install the profile, then Settings > General > About > Certificate Trust Settings: turn it on"
  _out "${i}Android:  Settings > Security > Encryption & credentials > Install a certificate > CA certificate"
  _out "${i}Firefox:  Settings > Privacy & Security > Certificates > View Certificates > Authorities > Import, trust for websites"
}
