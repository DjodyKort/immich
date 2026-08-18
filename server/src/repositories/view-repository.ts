import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { DB } from 'src/schema';
import { asUuid, withExif } from 'src/utils/database';
import { PolicyContext, Surface, surfacePredicate } from 'src/utils/visibility-policy';

export class ViewRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, { elevated: false }] })
  async getUniqueOriginalPaths(userId: string, ctx: PolicyContext) {
    const results = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn<string>('substring', ['asset.originalPath', eb.val('^(.*/)[^/]*$')]).as('directoryPath'))
      .distinct()
      .where('ownerId', '=', asUuid(userId))
      .where((eb) => surfacePredicate(eb, Surface.FolderView, ctx))
      .where('deletedAt', 'is', null)
      .where('fileCreatedAt', 'is not', null)
      .where('fileModifiedAt', 'is not', null)
      .where('localDateTime', 'is not', null)
      .orderBy('directoryPath', 'asc')
      .execute();

    return results.map((row) => row.directoryPath.replaceAll(/\/$/g, ''));
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING, { elevated: false }] })
  async getAssetsByOriginalPath(userId: string, partialPath: string, ctx: PolicyContext) {
    const normalizedPath = partialPath.replaceAll(/\/$/g, '');

    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .$call(withExif)
      .where('ownerId', '=', asUuid(userId))
      .where((eb) => surfacePredicate(eb, Surface.FolderView, ctx))
      .where('deletedAt', 'is', null)
      .where('fileCreatedAt', 'is not', null)
      .where('fileModifiedAt', 'is not', null)
      .where('localDateTime', 'is not', null)
      .where('originalPath', 'like', `%${normalizedPath}/%`)
      .where('originalPath', 'not like', `%${normalizedPath}/%/%`)
      .orderBy(
        (eb) => eb.fn('regexp_replace', ['asset.originalPath', eb.val('.*/(.+)'), eb.val(String.raw`\1`)]),
        'asc',
      )
      .execute();
  }
}
