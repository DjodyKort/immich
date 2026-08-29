import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" ADD "parentId" uuid;`.execute(db);
  await sql`ALTER TABLE "album" ADD CONSTRAINT "album_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(db);
  await sql`CREATE INDEX "album_parentId_idx" ON "album" ("parentId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "album_parentId_idx";`.execute(db);
  await sql`ALTER TABLE "album" DROP CONSTRAINT "album_parentId_fkey";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "parentId";`.execute(db);
}
