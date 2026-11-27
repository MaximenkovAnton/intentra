import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { users, type UserRow } from '../db/schema.js';

const DEV_SUBJECT = 'dev:local';

export async function provisionDevUser(db: Database): Promise<UserRow> {
  const [existing] = await db.select().from(users).where(eq(users.idpSubject, DEV_SUBJECT)).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({
      idpSubject: DEV_SUBJECT,
      email: 'dev@intentra.local',
      name: 'Dev User',
      avatarUrl: null,
      groups: [],
      locale: 'ru',
      isAdmin: true,
      status: 'active',
    })
    .returning();
  if (!created) throw new Error('dev user insert returned no row');
  return created;
}
