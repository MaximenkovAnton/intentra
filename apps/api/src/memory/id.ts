import { createHash } from 'node:crypto';
import type { GraphNodeKind } from './types.js';

const NAMESPACE = '9c1d7f42-5a3b-4e6c-8f0a-2b4d6e8a0c1e';
const NAMESPACE_BYTES = Buffer.from(NAMESPACE.replaceAll('-', ''), 'hex');

export function uuidv5(name: string): string {
  const hash = createHash('sha1').update(NAMESPACE_BYTES).update(name, 'utf8').digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function memoryId(projectId: string, kind: GraphNodeKind, key: string): string {
  return uuidv5(`${projectId}:${kind}:${key}`);
}
