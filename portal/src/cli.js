#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { validateManifest } from './validate-manifest.js';
import { readPlatformConfig } from './config.js';

// Sem caminho explicito, procura o manifesto pelo nome configurado
// (MANIFEST_FILENAME) e depois pelos apelidos (MANIFEST_FILENAME_ALIASES).
export function resolveDefaultManifestPath(cwd = process.cwd(), config = readPlatformConfig()) {
  const candidates = [config.manifestFilename, ...config.manifestAliases];
  for (const candidate of candidates) {
    const resolved = path.resolve(cwd, candidate);
    if (existsSync(resolved)) return resolved;
  }
  return path.resolve(cwd, config.manifestFilename);
}

function usage() {
  console.log(`Usage:
  ihc-portal validate [manifest-path]

Examples:
  ihc-portal validate
  ihc-portal validate ./company-app.yaml`);
}

function readManifest(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  return YAML.parse(raw);
}

async function main(argv) {
  const command = argv[2];

  if (!command || command === '--help' || command === '-h') {
    usage();
    return 0;
  }

  if (command !== 'validate') {
    console.error(`Unknown command: ${command}`);
    usage();
    return 2;
  }

  const args = argv.slice(3);
  const unknownOption = args.find((arg) => arg.startsWith('--'));
  if (unknownOption || args.length > 1) {
    console.error(unknownOption ? `Unknown option: ${unknownOption}` : `Unexpected argument: ${args[1]}`);
    usage();
    return 2;
  }

  const manifestPath = args[0] ? path.resolve(args[0]) : resolveDefaultManifestPath();
  if (!existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    return 1;
  }

  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (error) {
    console.error(`Invalid YAML: ${error.message}`);
    return 1;
  }

  const result = validateManifest(manifest, {
    manifestPath,
    rootDir: path.dirname(manifestPath),
  });

  if (!result.ok) {
    console.error(`${path.basename(manifestPath)} is invalid:`);
    for (const issue of result.issues) {
      console.error(`- ${issue.path}: ${issue.message}`);
    }
    return 1;
  }

  console.log(`${path.basename(manifestPath)} is valid: ${result.appSlug}`);
  if (result.deployEnabled) {
    console.log(`deploy: enabled (${result.domain}, port ${result.port})`);
  } else {
    console.log('deploy: disabled');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv);
}
