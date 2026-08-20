import { createZodDto } from 'nestjs-zod';
import { HistoryBuilder } from 'src/decorators';
import { BulkIdsSchema } from 'src/dtos/asset-ids.response.dto';
import { AssetSurfaceSchema, AssetType, AssetVisibilitySchema } from 'src/enum';
import { AssetStats } from 'src/repositories/asset.repository';
import { IsNotSiblingOf, isoDatetimeToDate, latitudeSchema, longitudeSchema, stringToBool } from 'src/validation';
import z from 'zod';

const UpdateAssetBaseSchema = z
  .object({
    isFavorite: z.boolean().optional().describe('Mark as favorite'),
    visibility: AssetVisibilitySchema.optional(),
    dateTimeOriginal: z.string().optional().describe('Original date and time'),
    latitude: latitudeSchema.optional().describe('Latitude coordinate'),
    longitude: longitudeSchema.optional().describe('Longitude coordinate'),
    rating: z
      .int()
      .min(-1)
      .max(5)
      .nullish()
      .refine((v) => v !== 0, {
        error: 'Rating must be -1 (rejected), 1–5 (starred), or null (unrated); 0 is not valid',
      })
      .describe('Rating in range [1-5] (starred), -1 (rejected), or null (unrated)')
      .meta({
        ...new HistoryBuilder()
          .added('v1')
          .stable('v2')
          .updated('v3', 'Using 0 as a rating is no longer valid.')
          .getExtensions(),
      }),
    description: z.string().optional().describe('Asset description'),
    hiddenFrom: z
      .array(AssetSurfaceSchema)
      .nullish()
      .describe(
        'Surfaces to withhold this asset from. Replaces the whole set: the array given becomes the complete list of exclusions, and `null` or `[]` clears them all. Independent of `visibility` -- an asset withheld from a surface is otherwise a normal asset.',
      ),
  })
  .refine(
    (data) =>
      (data.latitude === undefined && data.longitude === undefined) ||
      (data.latitude !== undefined && data.longitude !== undefined),
    { message: 'Latitude and longitude must be provided together' },
  );

const AssetBulkUpdateBaseSchema = UpdateAssetBaseSchema.extend({
  ids: z.array(z.uuidv4()).describe('Asset IDs to update'),
  duplicateId: z.string().nullish().describe('Duplicate ID'),
  dateTimeRelative: z.int().optional().describe('Relative time offset in minutes'),
  timeZone: z.string().optional().describe('Time zone (IANA timezone)'),
  hiddenFromAdd: z
    .array(AssetSurfaceSchema)
    .optional()
    .describe(
      "Surfaces to add to each asset's exclusions, leaving its other exclusions alone. Use this rather than `hiddenFrom` for a multi-asset selection: `hiddenFrom` replaces the whole set, so applying it to assets that are withheld from different places silently discards the difference. Mutually exclusive with `hiddenFrom`.",
    ),
  hiddenFromRemove: z
    .array(AssetSurfaceSchema)
    .optional()
    .describe(
      "Surfaces to remove from each asset's exclusions, leaving its other exclusions alone. The counterpart of `hiddenFromAdd`; a surface named in both is rejected. Mutually exclusive with `hiddenFrom`.",
    ),
});

const AssetBulkUpdateSchema = AssetBulkUpdateBaseSchema.pipe(
  IsNotSiblingOf(AssetBulkUpdateBaseSchema, 'dateTimeRelative', ['dateTimeOriginal']),
)
  // `hiddenFrom` replaces and the other two adjust, so honouring both at once would mean picking an
  // order and calling it obvious. Rejecting the combination is the honest option.
  .refine((data) => data.hiddenFrom === undefined || (!data.hiddenFromAdd && !data.hiddenFromRemove), {
    error: 'hiddenFrom replaces the whole set and cannot be combined with hiddenFromAdd or hiddenFromRemove',
  })
  // Add wins over remove in the SQL, so an overlap would quietly do something other than either
  // reading of it.
  .refine((data) => !data.hiddenFromAdd?.some((surface) => data.hiddenFromRemove?.includes(surface)), {
    error: 'A surface cannot appear in both hiddenFromAdd and hiddenFromRemove',
  })
  .meta({ id: 'AssetBulkUpdateDto' });

const UpdateAssetSchema = UpdateAssetBaseSchema.extend({
  livePhotoVideoId: z.uuidv4().nullish().describe('Live photo video ID'),
}).meta({ id: 'UpdateAssetDto' });

const AssetBulkDeleteSchema = BulkIdsSchema.extend({
  force: z.boolean().optional().describe('Force delete even if in use'),
}).meta({ id: 'AssetBulkDeleteDto' });

export const AssetIdsSchema = z
  .object({
    assetIds: z.array(z.uuidv4()).describe('Asset IDs'),
  })
  .meta({ id: 'AssetIdsDto' });

export enum AssetJobName {
  REFRESH_FACES = 'refresh-faces',
  REFRESH_METADATA = 'refresh-metadata',
  REGENERATE_THUMBNAIL = 'regenerate-thumbnail',
  TRANSCODE_VIDEO = 'transcode-video',
}

const AssetJobNameSchema = z.enum(AssetJobName).describe('Job name').meta({ id: 'AssetJobName' });

const AssetJobsSchema = AssetIdsSchema.extend({
  name: AssetJobNameSchema,
}).meta({ id: 'AssetJobsDto' });

const AssetStatsSchema = z
  .object({
    visibility: AssetVisibilitySchema.optional(),
    isFavorite: stringToBool.optional().describe('Filter by favorite status'),
    isTrashed: stringToBool.optional().describe('Filter by trash status'),
  })
  .meta({ id: 'AssetStatsDto' });

const AssetStatsResponseSchema = z
  .object({
    images: z.int().describe('Number of images'),
    videos: z.int().describe('Number of videos'),
    total: z.int().describe('Total number of assets'),
  })
  .meta({ id: 'AssetStatsResponseDto' });

const AssetMetadataRouteParamsSchema = z
  .object({
    id: z.uuidv4().describe('Asset ID'),
    key: z.string().describe('Metadata key'),
  })
  .meta({ id: 'AssetMetadataRouteParams' });

export const AssetMetadataUpsertItemSchema = z
  .object({
    key: z.string().describe('Metadata key'),
    value: z.record(z.string(), z.unknown()).describe('Metadata value (object)'),
  })
  .meta({ id: 'AssetMetadataUpsertItemDto' });

const AssetMetadataUpsertSchema = z
  .object({
    items: z.array(AssetMetadataUpsertItemSchema).describe('Metadata items to upsert'),
  })
  .meta({ id: 'AssetMetadataUpsertDto' });

const AssetMetadataBulkUpsertItemSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    key: z.string().describe('Metadata key'),
    value: z.record(z.string(), z.unknown()).describe('Metadata value (object)'),
  })
  .meta({ id: 'AssetMetadataBulkUpsertItemDto' });

const AssetMetadataBulkUpsertSchema = z
  .object({
    items: z.array(AssetMetadataBulkUpsertItemSchema).describe('Metadata items to upsert'),
  })
  .meta({ id: 'AssetMetadataBulkUpsertDto' });

const AssetMetadataBulkDeleteItemSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    key: z.string().describe('Metadata key'),
  })
  .meta({ id: 'AssetMetadataBulkDeleteItemDto' });

const AssetMetadataBulkDeleteSchema = z
  .object({
    items: z.array(AssetMetadataBulkDeleteItemSchema).describe('Metadata items to delete'),
  })
  .meta({ id: 'AssetMetadataBulkDeleteDto' });

const AssetMetadataResponseSchema = z
  .object({
    key: z.string().describe('Metadata key'),
    value: z.record(z.string(), z.unknown()).describe('Metadata value (object)'),
    updatedAt: isoDatetimeToDate.describe('Last update date'),
  })
  .meta({ id: 'AssetMetadataResponseDto' });

const AssetMetadataBulkResponseSchema = AssetMetadataResponseSchema.extend({
  assetId: z.uuidv4().describe('Asset ID'),
}).meta({ id: 'AssetMetadataBulkResponseDto' });

const AssetCopySchema = z
  .object({
    sourceId: z.uuidv4().describe('Source asset ID'),
    targetId: z.uuidv4().describe('Target asset ID'),
    sharedLinks: z.boolean().default(true).optional().describe('Copy shared links'),
    albums: z.boolean().default(true).optional().describe('Copy album associations'),
    sidecar: z.boolean().default(true).optional().describe('Copy sidecar file'),
    stack: z.boolean().default(true).optional().describe('Copy stack association'),
    favorite: z.boolean().default(true).optional().describe('Copy favorite status'),
  })
  .meta({ id: 'AssetCopyDto' });

const AssetDownloadOriginalSchema = z
  .object({
    edited: stringToBool.default(false).optional().describe('Return edited asset if available'),
  })
  .meta({ id: 'AssetDownloadOriginalDto' });

export const mapStats = (stats: AssetStats): AssetStatsResponseDto => {
  return {
    images: stats[AssetType.Image],
    videos: stats[AssetType.Video],
    total: Object.values(stats).reduce((total, value) => total + value, 0),
  };
};

export class AssetBulkUpdateDto extends createZodDto(AssetBulkUpdateSchema) {}
export class UpdateAssetDto extends createZodDto(UpdateAssetSchema) {}
export class AssetBulkDeleteDto extends createZodDto(AssetBulkDeleteSchema) {}
export class AssetIdsDto extends createZodDto(AssetIdsSchema) {}
export class AssetJobsDto extends createZodDto(AssetJobsSchema) {}
export class AssetStatsDto extends createZodDto(AssetStatsSchema) {}
export class AssetStatsResponseDto extends createZodDto(AssetStatsResponseSchema) {}
export class AssetMetadataRouteParams extends createZodDto(AssetMetadataRouteParamsSchema) {}
export class AssetMetadataUpsertDto extends createZodDto(AssetMetadataUpsertSchema) {}
export class AssetMetadataBulkUpsertDto extends createZodDto(AssetMetadataBulkUpsertSchema) {}
export class AssetMetadataBulkDeleteDto extends createZodDto(AssetMetadataBulkDeleteSchema) {}
export class AssetMetadataResponseDto extends createZodDto(AssetMetadataResponseSchema) {}
export class AssetMetadataBulkResponseDto extends createZodDto(AssetMetadataBulkResponseSchema) {}
export class AssetCopyDto extends createZodDto(AssetCopySchema) {}
export class AssetDownloadOriginalDto extends createZodDto(AssetDownloadOriginalSchema) {}
