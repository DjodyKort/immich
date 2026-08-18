import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';
import { anyUuid } from 'src/utils/database';
import { PolicyContext, Surface, withSurface } from 'src/utils/visibility-policy';

const builder = (db: Kysely<DB>) =>
  db
    .selectFrom('asset')
    .innerJoin('asset_exif', 'assetId', 'id')
    .select(['asset.id', 'asset.livePhotoVideoId', 'asset_exif.fileSizeInByte as size'])
    .where('asset.deletedAt', 'is', null);

@Injectable()
export class DownloadRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  downloadAssetIds(ids: string[]) {
    return builder(this.db).where('asset.id', '=', anyUuid(ids)).stream();
  }

  downloadMotionAssetIds(ids: string[]) {
    return builder(this.db).select(['asset.originalPath']).where('asset.id', '=', anyUuid(ids)).stream();
  }

  downloadAlbumId(albumId: string) {
    return builder(this.db)
      .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .stream();
  }

  downloadUserId(userId: string, ctx: PolicyContext) {
    return (
      builder(this.db)
        .where('asset.ownerId', '=', userId)
        // Permission.TimelineDownload only checks that the requested id is the caller's own, so without
        // this a non-elevated session received the ids and byte sizes of every locked asset. The ids
        // then failed Permission.AssetDownload on the follow-up archive call, taking the whole request
        // down with them.
        .$call((qb) => withSurface(qb, Surface.TimelineDownload, ctx))
        .stream()
    );
  }
}
