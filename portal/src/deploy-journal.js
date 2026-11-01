import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getInventoryPath } from './inventory.js';

// Journal de deploys de cada app, so leitura.
//
// Quem escreve e o `ihc-app apply` e o `ihc-app rollback` do cloud
// (scripts/lib/deployjournal.py tem o formato): <install-dir>/catalog/deploys/<slug>.jsonl,
// uma linha JSON por evento, append-only. Cada apply ou rollback e uma transacao `tx`:
// `begin` (antes de mudar qualquer coisa: release e commit de antes e de depois, imagens,
// sha256 do overlay, nomes das chaves do env file), `step` (provision com as chaves
// adicionadas, removidas e alteradas; `applied` quando os containers ja rodam a release que entrou)
// e `end` com o resultado. Valores do env file nunca entram no journal, so nomes de chave.
// O portal monta catalog/ so leitura, entao le o journal ao lado do inventario.

const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export function deployJournalDir(env = process.env) {
  const configured = typeof env.DEPLOY_JOURNAL_DIR === 'string' ? env.DEPLOY_JOURNAL_DIR.trim() : '';
  if (configured) return configured;
  const inventory = getInventoryPath(env);
  return inventory ? path.join(path.dirname(inventory), 'deploys') : null;
}

// Agrupa as linhas por transacao, da mais antiga para a mais recente (mesma regra do
// deployjournal.py: sem `end`, a transacao foi interrompida).
export function parseDeployJournal(text) {
  const byTx = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || !entry.tx) continue;
    if (!byTx.has(entry.tx)) {
      byTx.set(entry.tx, { tx: entry.tx, steps: [], applied: false, result: null, ended_at: null });
    }
    const tx = byTx.get(entry.tx);
    if (entry.phase === 'begin') {
      for (const [key, value] of Object.entries(entry)) {
        if (key !== 'phase' && key !== 'at') tx[key] = value;
      }
      tx.started_at = entry.at ?? null;
    } else if (entry.phase === 'step') {
      const { tx: _tx, phase: _phase, ...step } = entry;
      tx.steps.push(step);
      if (entry.step === 'applied') tx.applied = true;
      if (entry.step === 'provision') {
        tx.env = {
          env_keys_added: entry.env_keys_added ?? [],
          env_keys_removed: entry.env_keys_removed ?? [],
          env_keys_changed: entry.env_keys_changed ?? [],
        };
      }
    } else if (entry.phase === 'end') {
      tx.result = entry.result ?? null;
      tx.ended_at = entry.at ?? null;
      for (const key of ['error', 'health', 'step', 'message']) {
        if (key in entry) tx[`end_${key}`] = entry[key];
      }
    }
  }
  const transactions = Array.from(byTx.values());
  for (const tx of transactions) {
    if (tx.result == null) tx.result = 'interrupted';
  }
  return transactions;
}

// O que `ihc-app rollback` desfaria agora: o deploy aplicado mais novo que ainda nao foi
// desfeito volta para a release que ele substituiu.
export function undoTarget(transactions) {
  const reverted = new Set(transactions.filter((tx) => tx.op === 'rollback' && tx.applied).map((tx) => tx.reverts));
  const stack = transactions.filter((tx) => tx.op === 'deploy' && tx.applied && !reverted.has(tx.tx));
  const top = stack.at(-1);
  if (!top) return { available: false, reason: transactions.length ? 'nothing_applied_to_undo' : 'no_deploys' };
  if (!top.before?.release) return { available: false, reason: 'replaced_version_not_journaled', reverts: top.tx };
  return {
    available: true,
    reverts: top.tx,
    from_release: top.after?.release ?? null,
    from_commit: top.after?.commit ?? null,
    to_release: top.before.release,
    to_commit: top.before.commit ?? null,
  };
}

export function readDeployJournal(slug, { dir = deployJournalDir(), limit = 20 } = {}) {
  if (!SLUG.test(String(slug ?? ''))) {
    return { available: false, error: 'invalid_slug', exists: false, transactions: [], undo: null };
  }
  if (!dir) {
    return { available: false, error: 'not_configured', exists: false, transactions: [], undo: null };
  }
  const file = path.join(dir, `${slug}.jsonl`);
  if (!existsSync(file)) {
    return { available: true, error: null, exists: false, transactions: [], undo: undoTarget([]) };
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { available: false, error: error.code || 'read_failed', exists: true, transactions: [], undo: null };
  }
  const all = parseDeployJournal(text);
  const max = Math.max(1, Math.min(200, Number(limit) || 20));
  return {
    available: true,
    error: null,
    exists: true,
    total: all.length,
    transactions: all.slice().reverse().slice(0, max),
    undo: undoTarget(all),
  };
}
