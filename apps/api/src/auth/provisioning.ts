import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { users, type UserRow } from '../db/schema.js';
import { HttpError } from '../errors.js';
import type { OidcIdentity } from './oidc.js';

export async function provisionUser(
  db: Database,
  identity: OidcIdentity,
  adminGroup: string,
): Promise<UserRow> {
  const isAdmin = identity.groups.includes(adminGroup);
  const profile = {
    email: identity.email,
    name: identity.name,
    avatarUrl: identity.avatarUrl,
    groups: identity.groups,
    isAdmin,
  };

  const [bySubject] = await db.select().from(users).where(eq(users.idpSubject, identity.subject)).limit(1);
  if (bySubject) {
    const [updated] = await db.update(users).set(profile).where(eq(users.id, bySubject.id)).returning();
    if (!updated) throw new Error('user update returned no row');
    return updated;
  }

  const [byEmail] = await db.select().from(users).where(eq(users.email, identity.email)).limit(1);
  if (byEmail) {
    if (!identity.emailVerified) throw new HttpError('AUTH_REQUIRED', 'OIDC email is not verified');
    const [updated] = await db
      .update(users)
      .set({ ...profile, idpSubject: identity.subject })
      .where(eq(users.id, byEmail.id))
      .returning();
    if (!updated) throw new Error('user update returned no row');
    return updated;
  }

  const [created] = await db
    .insert(users)
    .values({ ...profile, idpSubject: identity.subject, status: 'active' })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await db.select().from(users).where(eq(users.idpSubject, identity.subject)).limit(1);
  if (!raced) throw new HttpError('CONFLICT', 'User account could not be provisioned');
  return raced;
}
