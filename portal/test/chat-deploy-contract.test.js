// The chat deploy contract (docs/chat-deploy-contract.md): every example in
// schemas/examples/chat-deploy/ must match the schema's definition it names when it says
// "valid": true, and must be refused when it says false. Proposed contract; the tools do
// not exist yet, so this only keeps the schema and its examples honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(root, 'schemas', 'chat-deploy.schema.json'), 'utf8'));
const examplesDir = join(root, 'schemas', 'examples', 'chat-deploy');
const examples = readdirSync(examplesDir).filter((f) => f.endsWith('.json')).sort();

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema);

function validatorFor(def) {
  assert.ok(schema.$defs[def], `the schema has no definition ${def}`);
  return ajv.getSchema(`${schema.$id}#/$defs/${def}`);
}

test('every example names a definition and says whether it is valid', () => {
  assert.ok(examples.length >= 20, 'expected the example set to be in place');
  for (const file of examples) {
    const ex = JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
    assert.equal(typeof ex.def, 'string', `${file}: def`);
    assert.equal(typeof ex.valid, 'boolean', `${file}: valid`);
    assert.ok(file.startsWith(ex.valid ? 'valid-' : 'invalid-'), `${file}: the name says ${ex.valid ? 'valid' : 'invalid'}`);
  }
});

for (const file of examples) {
  const ex = JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
  test(`${file}: ${ex.note}`, () => {
    const validate = validatorFor(ex.def);
    const ok = validate(ex.value);
    if (ex.valid) assert.ok(ok, `${file} should match ${ex.def}: ${ajv.errorsText(validate.errors)}`);
    else assert.ok(!ok, `${file} should not match ${ex.def}`);
  });
}

test('every tool of the contract has its input and output defined', () => {
  for (const def of ['AppSpecInput', 'AppSpecOutput', 'AppCheckInput', 'AppDeployInput', 'JobAccepted', 'DeployStatusInput', 'DeployStatusOutput', 'Finding']) {
    assert.ok(schema.$defs[def], def);
  }
});

test('the codes in the doc table are well formed and use a known stage', () => {
  const doc = readFileSync(join(root, 'docs', 'chat-deploy-contract.md'), 'utf8');
  const stages = new Set(schema.$defs.Stage.enum);
  const rows = [...doc.matchAll(/^\| `(IHC-[A-Z0-9-]+)` \| ([a-z]+) \|/gm)];
  assert.ok(rows.length >= 20, 'the first codes table');
  const code = validatorFor('FindingCode');
  for (const [, c, stage] of rows) {
    assert.ok(code(c), `${c} is not a valid code`);
    assert.ok(stages.has(stage), `${c}: unknown stage ${stage}`);
  }
});
