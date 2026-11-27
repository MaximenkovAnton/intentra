import { gt, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { HttpError } from './errors.js';

export interface CreatedAtCursor {
  readonly createdAt: string;
  readonly id: string;
}

const CreatedAtSchema = z.iso.datetime({ offset: true });
const IdSchema = z.string().uuid();

export function encodeCursor(cursor: CreatedAtCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CreatedAtCursor {
  const [createdAt, id, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const timestamp = CreatedAtSchema.safeParse(createdAt);
  const uuid = IdSchema.safeParse(id);
  if (rest.length > 0 || !timestamp.success || !uuid.success) {
    throw new HttpError('VALIDATION', 'Invalid pagination cursor');
  }
  return { createdAt: timestamp.data, id: uuid.data };
}

export function createdAtText(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function encodeIdCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeIdCursor(raw: string): string {
  const parsed = IdSchema.safeParse(Buffer.from(raw, 'base64url').toString('utf8'));
  if (!parsed.success) throw new HttpError('VALIDATION', 'Invalid pagination cursor');
  return parsed.data;
}

export function afterCreatedAt(
  createdAtColumn: AnyPgColumn,
  idColumn: AnyPgColumn,
  cursor: CreatedAtCursor,
): SQL {
  return sql`(${createdAtColumn} < ${cursor.createdAt}::timestamptz or (${createdAtColumn} = ${cursor.createdAt}::timestamptz and ${idColumn} < ${cursor.id}))`;
}

export function afterId(idColumn: AnyPgColumn, id: string): SQL {
  return gt(idColumn, id);
}

export function pageOf<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (row: T) => string,
): { page: T[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { page, nextCursor: rows.length > limit && last ? toCursor(last) : null };
}
