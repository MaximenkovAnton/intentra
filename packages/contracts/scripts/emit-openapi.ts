import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../src/openapi.js';

const root = dirname(fileURLToPath(import.meta.url));
const target = join(root, '..', 'openapi.json');
const document = buildOpenApiDocument();
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`wrote ${target}`);
