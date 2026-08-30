import { ShallowDehydrateObject } from 'kysely';
import { createZodDto } from 'nestjs-zod';
import { AlbumUser, AuthSharedLink } from 'src/database';
import { HistoryBuilder } from 'src/decorators';
import { BulkIdErrorReasonSchema } from 'src/dtos/asset-ids.response.dto';
import { MapAsset } from 'src/dtos/asset-response.dto';
import { UserResponseSchema, mapUser } from 'src/dtos/user.dto';
import { AlbumUserRole, AlbumUserRoleSchema, AssetOrder, AssetOrderSchema, AssetSurfaceSchema } from 'src/enum';
import { MaybeDehydrated } from 'src/types';
import { asDateTimeString } from 'src/utils/date';
import { fromHiddenFromMask } from 'src/utils/visibility-policy';
import { stringToBool } from 'src/validation';
import z from 'zod';

const AlbumUserAddSchema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    role: AlbumUserRoleSchema.default(AlbumUserRole.Editor).optional().describe('Album user role'),
  })
  .meta({ id: 'AlbumUserAddDto' });

const AddUsersSchema = z
  .object({
    albumUsers: z.array(AlbumUserAddSchema).min(1).describe('Album users to add'),
  })
  .meta({ id: 'AddUsersDto' });

const AlbumUserCreateSchema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    role: AlbumUserRoleSchema,
  })
  .meta({ id: 'AlbumUserCreateDto' });

const CreateAlbumSchema = z
  .object({
    albumName: z.string().describe('Album name'),
    // TODO: drop the empty-string-to-null transform in v4 (clients should send null)
    description: z
      .string()
      .nullable()
      .transform((value) => (value === '' ? null : value))
      .optional()
      .describe('Album description')
      .meta({
        ...new HistoryBuilder()
          .added('v1')
          .updated(
            'v3',
            'Sending an empty string is deprecated; send null instead. Empty strings will no longer be coerced to null in v4.',
          )
          .getExtensions(),
      }),
    albumUsers: z.array(AlbumUserCreateSchema).optional().describe('Album users'),
    assetIds: z.array(z.uuidv4()).optional().describe('Initial asset IDs'),
    parentId: z
      .uuidv4()
      .optional()
      .describe(
        'Create the album inside this one. Must be an album you own. A locked parent may only take a locked album, matching the move endpoint; the reverse -- a locked album inside a normal one -- is allowed. Omit for a top-level album.',
      ),
    isLocked: z
      .boolean()
      .optional()
      .describe(
        'Create the album already locked. Every asset in `assetIds` must already have Locked visibility (i.e. already be in the locked folder) -- an album can only ever be locked at creation time, and can only ever contain assets that are already locked.',
      ),
  })
  .meta({ id: 'CreateAlbumDto' });

const AlbumsAddAssetsSchema = z
  .object({
    albumIds: z.array(z.uuidv4()).describe('Album IDs'),
    assetIds: z.array(z.uuidv4()).describe('Asset IDs'),
  })
  .meta({ id: 'AlbumsAddAssetsDto' });

const AlbumsAddAssetsResponseSchema = z
  .object({
    success: z.boolean().describe('Operation success'),
    error: BulkIdErrorReasonSchema.optional(),
  })
  .meta({ id: 'AlbumsAddAssetsResponseDto' });

const UpdateAlbumSchema = z
  .object({
    albumName: z.string().optional().describe('Album name'),
    // TODO: drop the empty-string-to-null transform in v4 (clients should send null)
    description: z
      .string()
      .nullable()
      .transform((value) => (value === '' ? null : value))
      .optional()
      .describe('Album description')
      .meta({
        ...new HistoryBuilder()
          .added('v1')
          .updated(
            'v3',
            'Sending an empty string is deprecated; send null instead. Empty strings will no longer be coerced to null in v4.',
          )
          .getExtensions(),
      }),
    albumThumbnailAssetId: z.uuidv4().optional().describe('Album thumbnail asset ID'),
    isActivityEnabled: z.boolean().optional().describe('Enable activity feed'),
    order: AssetOrderSchema.optional(),
    // Deliberately absent here: `isLocked`. Locking an existing album is not a property assignment -
    // it moves every asset in the album into the locked folder and evicts them from every other album -
    // so it gets its own route rather than riding along with a rename. See AlbumSetLockedDto.
    // Hiding carries no such invariant: it is about the album list, not about confidentiality, so it
    // can be turned on and off freely.
    isHidden: z.boolean().optional().describe('Keep this album out of the album list'),
  })
  .meta({ id: 'UpdateAlbumDto' });

/**
 * Locking or unlocking an existing album, contents and all.
 *
 * Its own DTO and its own route because it is a transactional move rather than a field set: locking
 * also sets every member asset to Locked visibility and removes them from every other album, and
 * unlocking puts them back on the timeline. Folding that into `UpdateAlbumDto` would allow "rename
 * and lock" to half-apply.
 */
const AlbumSetLockedSchema = z
  .object({
    includeSubAlbums: z
      .boolean()
      .optional()
      .describe(
        "Apply to every album beneath this one as well. Locking cascades **downward only** -- it never touches this album's parent or its siblings, because those are albums the caller did not name and locking one would move its photos out of the timeline and out of every other album they are in. Preview the effect first with the lock-impact endpoint. Without this, an album with sub-albums is refused rather than half-locked.",
      ),
    isLocked: z
      .boolean()
      .describe(
        'Whether the album, and every asset in it, should live behind the locked folder. Locking requires an elevated session, an album you own, that is shared with nobody and has no shared links, and whose every asset you own; it sets those assets to Locked visibility and removes them from all other albums. Unlocking returns them to the timeline -- including any that were archived beforehand, since `visibility` is a single exclusive column -- and leaves them in this album.',
      ),
  })
  .meta({ id: 'AlbumSetLockedDto' });

/**
 * The album's per-surface rule for its photos.
 *
 * Its own route for the same reason as `AlbumSetLockedDto`: it rewrites derived state on every member
 * asset, so it must not be able to half-apply alongside a rename. Unlike locking it carries no
 * invariant and needs no elevation - it is about where photos appear, not about confidentiality.
 */
const AlbumSetHiddenFromSchema = z
  .object({
    hiddenFrom: z
      .array(AssetSurfaceSchema)
      .describe(
        "Surfaces to withhold this album's photos from. Replaces the whole set; `[]` clears the rule. Photos inherit this on joining and stop inheriting it on leaving, and rules from several albums combine -- a photo hidden by any of its albums is hidden. A photo can opt back out individually with `hiddenFromShown`. Distinct from `isHidden`, which hides the album itself and touches no photo.",
      ),
  })
  .meta({ id: 'AlbumSetHiddenFromDto' });

/**
 * Where an album sits in the tree.
 *
 * Its own route for the same reason as `AlbumSetLockedDto`: unlike a rename this is validated against
 * the rest of the hierarchy -- ownership, cycles, depth, and the locked-flows-down rule -- and a move
 * that half-applied alongside a rename would leave the tree in a state no check had approved.
 */
const AlbumSetParentSchema = z
  .object({
    parentId: z
      .uuidv4()
      .nullable()
      .describe(
        'The album to move this one inside, or null to move it to the top level. Must be an album you own; it may not be this album, nor any album beneath it, and the resulting tree may not exceed the depth limit. Locked flows down, never up: a normal album may not be moved into a locked one. The reverse is allowed -- a locked album may sit inside a normal one, and may always be moved to the top level.',
      ),
  })
  .meta({ id: 'AlbumSetParentDto' });

/**
 * What locking an album, or an album and its subtree, would do -- without doing it.
 *
 * Its own read-only endpoint rather than a `dryRun` flag on the write route, so nothing about the
 * preview can be mistaken for the operation. Locking is the one direction that is hard to explain
 * after the fact: photos leave the timeline, and they leave every other album they were in. This is
 * the number the confirm dialog shows, and the list of albums it names.
 */
const AlbumLockImpactQuerySchema = z
  .object({
    includeSubAlbums: z.stringbool().optional().describe('Include every album beneath this one in the preview.'),
  })
  .meta({ id: 'AlbumLockImpactDto' });

const AlbumLockImpactSchema = z
  .object({
    albums: z
      .array(z.object({ id: z.uuidv4(), albumName: z.string() }))
      .describe('The albums that would be locked, this one first.'),
    assetCount: z.number().describe('How many photos would move into the locked folder.'),
    evictions: z
      .array(z.object({ id: z.uuidv4(), albumName: z.string(), assetCount: z.number() }))
      .describe(
        'Other albums that would lose photos, because a locked asset may not remain in an ordinary album. Empty when nothing else is affected.',
      ),
    blockedReason: z
      .string()
      .nullable()
      .describe('Why the operation would be refused, or null if it would succeed. Shown instead of the confirm.'),
  })
  .meta({ id: 'AlbumLockImpactResponseDto' });

const GetAlbumsSchema = z
  .object({
    id: z.uuidv4().optional().describe('Album ID'),
    name: z.string().optional().describe('Album name (exact match)'),
    isOwned: stringToBool
      .optional()
      .describe('Filter by ownership: true = only owned, false = only shared-with-me, undefined = no filter'),
    isShared: stringToBool
      .optional()
      .describe('Filter by shared status: true = only shared, false = not shared, undefined = no filter'),
    assetId: z.uuidv4().optional().describe('Filter albums containing this asset ID (ignores other parameters)'),
    // stringToBool, not z.boolean(): this is a query parameter, so it arrives as the string "true".
    // A plain boolean schema rejects it with "expected boolean, received string", which the medium
    // tests cannot catch because they call the service with a real boolean and never cross the wire.
    hidden: stringToBool
      .optional()
      .describe('true lists only hidden albums, the review view for album hiding. Omitted or false leaves them out.'),
  })
  .meta({ id: 'GetAlbumsDto' });

const AlbumStatisticsResponseSchema = z
  .object({
    owned: z.int().min(0).describe('Number of owned albums'),
    shared: z.int().min(0).describe('Number of shared albums'),
    notShared: z.int().min(0).describe('Number of non-shared albums'),
  })
  .meta({ id: 'AlbumStatisticsResponseDto' });

const UpdateAlbumUserSchema = z
  .object({
    role: AlbumUserRoleSchema,
  })
  .meta({ id: 'UpdateAlbumUserDto' });

const AlbumUserResponseSchema = z
  .object({
    user: UserResponseSchema,
    role: AlbumUserRoleSchema,
  })
  .meta({ id: 'AlbumUserResponseDto' });

const ContributorCountResponseSchema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    assetCount: z.int().min(0).describe('Number of assets contributed'),
  })
  .meta({ id: 'ContributorCountResponseDto' });

export const AlbumResponseSchema = z
  .object({
    id: z.uuidv4().describe('Album ID'),
    albumName: z.string().describe('Album name'),
    description: z
      .string()
      .describe('Album description')
      .meta({
        ...new HistoryBuilder()
          .added('v1')
          .updated(
            'v3',
            'An empty string is returned instead of null for backwards compatibility; null will be returned in v4.',
          )
          .getExtensions(),
      }),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
    albumThumbnailAssetId: z.uuidv4().nullable().describe('Thumbnail asset ID'),
    shared: z.boolean().describe('Is shared album'),
    albumUsers: z
      .array(AlbumUserResponseSchema)
      .min(1)
      .describe(
        'First entry is always the album owner. Second entry is the auth user, if it differs from the owner. The rest are ordered alphabetically.',
      ),
    hasSharedLink: z.boolean().describe('Has shared link'),
    assetCount: z.int().min(0).describe('Number of assets'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    lastModifiedAssetTimestamp: z
      .string()
      .meta({ format: 'date-time' })
      .optional()
      .describe('Last modified asset timestamp'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    startDate: z.string().meta({ format: 'date-time' }).optional().describe('Start date (earliest asset)'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    endDate: z.string().meta({ format: 'date-time' }).optional().describe('End date (latest asset)'),
    isActivityEnabled: z.boolean().describe('Activity feed enabled'),
    isLocked: z.boolean().describe('Album is locked and requires PIN elevation to view'),
    isHidden: z.boolean().describe('Album is kept out of the album list, but remains reachable by URL'),
    hiddenFrom: z
      .array(AssetSurfaceSchema)
      .describe(
        "Surfaces this album's photos are withheld from. Empty means no rule. Distinct from `isHidden`, which hides the album itself.",
      ),
    parentId: z.uuidv4().nullable().describe('The album this one sits inside, or null at the top level'),
    childCount: z
      .number()
      .describe(
        'How many sub-albums this album has. Counted server-side rather than derived from the album list, which is already filtered by what the viewer may see.',
      ),
    order: AssetOrderSchema.optional(),
    contributorCounts: z.array(ContributorCountResponseSchema).optional(),
  })
  .meta({ id: 'AlbumResponseDto' });

const AlbumUserParamSchema = z.object({
  id: z.uuidv4().describe('Album ID'),
  // TODO: disallow 'me' as a shortcut in v4 and type userId as uuidv4
  userId: z
    .string()
    .refine((value) => value === 'me' || z.uuidv4().safeParse(value).success, {
      error: 'Must be a UUID v4 or "me"',
    })
    .describe('Album user ID, or "me" to reference the current user.')
    .meta(new HistoryBuilder().updated('v3', '"me" as a value is deprecated').getExtensions()),
});

export class AlbumUserParamDto extends createZodDto(AlbumUserParamSchema) {}
export class AddUsersDto extends createZodDto(AddUsersSchema) {}
export class AlbumUserCreateDto extends createZodDto(AlbumUserCreateSchema) {}
export class CreateAlbumDto extends createZodDto(CreateAlbumSchema) {}
export class AlbumsAddAssetsDto extends createZodDto(AlbumsAddAssetsSchema) {}
export class AlbumsAddAssetsResponseDto extends createZodDto(AlbumsAddAssetsResponseSchema) {}
export class UpdateAlbumDto extends createZodDto(UpdateAlbumSchema) {}
export class AlbumSetLockedDto extends createZodDto(AlbumSetLockedSchema) {}
export class AlbumSetHiddenFromDto extends createZodDto(AlbumSetHiddenFromSchema) {}
export class AlbumSetParentDto extends createZodDto(AlbumSetParentSchema) {}
export class AlbumLockImpactDto extends createZodDto(AlbumLockImpactQuerySchema) {}
export class AlbumLockImpactResponseDto extends createZodDto(AlbumLockImpactSchema) {}
export class GetAlbumsDto extends createZodDto(GetAlbumsSchema) {}
export class AlbumStatisticsResponseDto extends createZodDto(AlbumStatisticsResponseSchema) {}
export class UpdateAlbumUserDto extends createZodDto(UpdateAlbumUserSchema) {}
export class AlbumResponseDto extends createZodDto(AlbumResponseSchema) {}
class AlbumUserResponseDto extends createZodDto(AlbumUserResponseSchema) {}

export type MapAlbumDto = {
  albumUsers?: AlbumUser[];
  assets?: ShallowDehydrateObject<MapAsset>[];
  sharedLinks?: ShallowDehydrateObject<AuthSharedLink>[];
  albumName: string;
  description: string | null;
  albumThumbnailAssetId: string | null;
  createdAt: Date;
  updatedAt: Date;
  id: string;
  isActivityEnabled: boolean;
  isLocked: boolean;
  isHidden: boolean;
  hiddenFrom: number | null;
  parentId: string | null;
  /**
   * Optional here, but every route that returns an album must set it -- go through
   * `AlbumService.mapAlbumWithChildren`.
   *
   * It defaulted to 0 and most mutations left it out, so rename, move, lock and share all reported a
   * folder as childless. Web `Object.assign`s the response over its copy, so renaming a folder wrote
   * that 0 into the store and locking it then failed: the client sent no `includeSubAlbums` and the
   * server refused. Making it *required* would be the stronger guarantee, but the repository return
   * types are dehydrated row shapes that would each have to carry it, so the discipline lives in the
   * helper instead.
   */
  childCount?: number;
  order: AssetOrder;
};

export const mapAlbum = (entity: MaybeDehydrated<MapAlbumDto>): AlbumResponseDto => {
  const albumUsers: AlbumUserResponseDto[] = [];

  if (entity.albumUsers) {
    for (const albumUser of entity.albumUsers) {
      const user = mapUser(albumUser.user);
      albumUsers.push({
        user,
        role: albumUser.role,
      });
    }
  }

  const assets = entity.assets || [];

  const hasSharedLink = !!entity.sharedLinks && entity.sharedLinks.length > 0;
  const hasSharedUser = albumUsers.length > 1;

  let startDate = assets.at(0)?.localDateTime;
  let endDate = assets.at(-1)?.localDateTime;
  // Swap dates if start date is greater than end date.
  if (startDate && endDate && startDate > endDate) {
    [startDate, endDate] = [endDate, startDate];
  }

  return {
    albumName: entity.albumName,
    // TODO: return null instead of '' in v4
    description: entity.description ?? '',
    albumThumbnailAssetId: entity.albumThumbnailAssetId,
    createdAt: asDateTimeString(entity.createdAt),
    updatedAt: asDateTimeString(entity.updatedAt),
    id: entity.id,
    albumUsers,
    shared: hasSharedUser || hasSharedLink,
    hasSharedLink,
    startDate: asDateTimeString(startDate),
    endDate: asDateTimeString(endDate),
    assetCount: entity.assets?.length || 0,
    isActivityEnabled: entity.isActivityEnabled,
    isLocked: entity.isLocked,
    isHidden: entity.isHidden,
    // Clients speak in surface names; the bitmask never leaves the server, for the same reason the
    // workflow payload converts. See `toHiddenFromMask` / `fromHiddenFromMask`.
    hiddenFrom: fromHiddenFromMask(entity.hiddenFrom),
    parentId: entity.parentId,
    childCount: entity.childCount ?? 0,
    order: entity.order,
  };
};
