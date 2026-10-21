#!/bin/sh
# Falha se alguma palavra dos arquivos versionados (ou dos caminhos deles) estiver
# na lista de nomes privados. A lista (scripts/private-names.sha256) guarda so o
# SHA-256 de cada nome, um por linha, para os nomes nunca aparecerem em claro.
#
# Palavra: sequencia de letras, digitos, '.', '-' e '_', em minusculas. Para cada
# palavra o check compara a palavra inteira e cada trecho continuo das partes
# separadas por '.', '-' ou '_' (assim um nome dentro de dominio, e-mail ou caminho
# tambem casa).
#
# Uso: scripts/check-private-names.sh [lista]
# Para acrescentar um nome: printf '%s' 'nome' | shasum -a 256

set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
list=${1:-"$root/scripts/private-names.sha256"}

cd "$root"
git ls-files -z | node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const listPath = process.argv[1];
const hashes = new Set(
  readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[0-9a-f]{64}$/.test(line)),
);
if (hashes.size === 0) {
  console.error(`check-private-names: nenhum hash em ${listPath}`);
  process.exit(2);
}

const MAX_PARTS = 16;
const seen = new Map();
function isPrivate(word) {
  if (seen.has(word)) return seen.get(word);
  const candidates = new Set([word]);
  const pieces = word.split(/([._-])/);
  const parts = pieces.filter((_, index) => index % 2 === 0);
  if (parts.length > 1 && parts.length <= MAX_PARTS) {
    for (let start = 0; start < parts.length; start += 1) {
      for (let end = start; end < parts.length; end += 1) {
        candidates.add(pieces.slice(start * 2, end * 2 + 1).join(""));
      }
    }
  } else if (parts.length > MAX_PARTS) {
    parts.forEach((part) => candidates.add(part));
  }
  let hit = false;
  for (const candidate of candidates) {
    if (candidate && hashes.has(createHash("sha256").update(candidate).digest("hex"))) {
      hit = true;
      break;
    }
  }
  seen.set(word, hit);
  return hit;
}

function scan(text, onHit) {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const word of line.toLowerCase().match(/[\p{L}\p{N}._-]+/gu) ?? []) {
      if (isPrivate(word)) onHit(index + 1);
    }
  });
}

const files = readFileSync(0, "utf8").split("\0").filter(Boolean);
const self = "scripts/private-names.sha256";
let hits = 0;
for (const file of files) {
  scan(file, () => {
    hits += 1;
    console.error(`${file}: private name in the path`);
  });
  if (file === self) continue;
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }
  if (buffer.includes(0)) continue;
  const reported = new Set();
  scan(buffer.toString("utf8"), (line) => {
    if (reported.has(line)) return;
    reported.add(line);
    hits += 1;
    console.error(`${file}:${line}: private name`);
  });
}

if (hits > 0) {
  console.error(`check-private-names: ${hits} hit(s); remove the name or replace it with a generic example`);
  process.exit(1);
}
console.log(`check-private-names: ok (${files.length} files, ${hashes.size} hashes)`);
' "$list"
