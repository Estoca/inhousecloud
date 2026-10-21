import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(__dirname, '..');

export function fromRoot(...parts) {
  return path.join(projectRoot, ...parts);
}
