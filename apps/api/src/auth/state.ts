import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const PendingStateSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  codeVerifier: z.string().min(1),
  redirectPath: z.string().min(1).max(500),
});
export type PendingOidcState = z.infer<typeof PendingStateSchema>;

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');

export function sealOidcState(secret: string, state: PendingOidcState): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function openOidcState(secret: string, sealed: string): PendingOidcState | null {
  const [payload, signature] = sealed.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(secret, payload), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const parsed = PendingStateSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

export function safeRedirectPath(candidate: string | undefined): string {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  return candidate;
}
