import { createHash } from 'node:crypto';

export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

export function truncateBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const last = low === 0 ? 0 : value.charCodeAt(low - 1);
  if (last >= 0xd800 && last <= 0xdbff) low -= 1;
  return value.slice(0, low);
}
