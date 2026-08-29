import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_lock_restore" (
  "assetId" uuid NOT NULL,
  "priorVisibility" asset_visibility_enum NOT NULL,
  "priorAlbumIds" uuid[] NOT NULL,
  "lockedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_lock_restore_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_lock_restore_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_lock_restore";`.execute(db);
}
