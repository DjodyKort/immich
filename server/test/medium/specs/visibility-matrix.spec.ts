import { Kysely } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetVisibility, CalendarHeatmapType } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository';
import { AssetJobRepository } from 'src/repositories/asset-job.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { DownloadRepository } from 'src/repositories/download.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MapRepository } from 'src/repositories/map.repository';
import { OcrRepository } from 'src/repositories/ocr.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { SearchRepository } from 'src/repositories/search.repository';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { AlbumService } from 'src/services/album.service';
import { AssetService } from 'src/services/asset.service';
import { DownloadService } from 'src/services/download.service';
import { MapService } from 'src/services/map.service';
import { SearchService } from 'src/services/search.service';
import { TimelineService } from 'src/services/timeline.service';
import { UserService } from 'src/services/user.service';
import { MediumTestContext, newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

/**
 * Executable visibility matrix - a characterization oracle, not a bug hunt.
 *
 * For every value of `asset.visibility` and every user-facing read surface, this records whether the
 * asset is handed to a non-elevated session and to an elevated one. The expectations below are what
 * the code does TODAY, defects included; where a cell looks wrong it is annotated rather than
 * "corrected", so a later refactor of the visibility model can prove it changed nothing.
 *
 * Elevation is `auth.session.hasElevatedPermission`. Omitting `session` entirely from `factory.auth`
 * yields no session at all, which is the common non-elevated case; the elevated case passes
 * `session: { hasElevatedPermission: true }`.
 *
 * Every surface is driven at SERVICE level, so permission checks and the service-layer visibility
 * defaults are part of the measurement.
 *
 * Album membership for the four assets is inserted with `ctx.newAlbumAsset` (a bare INSERT via
 * `AlbumRepository.addAssetIds`) because `AlbumService.addAssets` refuses a Locked asset and
 * `AssetService.updateAll` evicts an asset from every album when it becomes Locked. That is the same
 * technique `locked-folder-boundary.spec.ts` uses, and the only way to observe what the album-scoped
 * read paths actually do with a Locked (or Hidden) member.
 */

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const Timeline = AssetVisibility.Timeline;
const Archive = AssetVisibility.Archive;
const Hidden = AssetVisibility.Hidden;
const Locked = AssetVisibility.Locked;

const ALL_VISIBILITIES = [Timeline, Archive, Hidden, Locked];

/** The month the four assets' `localDateTime` lands in, and the bucket key that selects it. */
const BUCKET_DATE = new Date('1970-02-12');
const BUCKET_KEY = '1970-02-01';

type Fixture = {
  userId: string;
  albumId: string;
  /** asset id, per visibility */
  ids: Record<AssetVisibility, string>;
};

type FixtureContext = Pick<MediumTestContext, 'newUser' | 'newAlbum' | 'newAsset' | 'newExif' | 'newAlbumAsset'>;

/**
 * One user, one ordinary (non-locked) album, and one asset per visibility - each with an EXIF row
 * carrying coordinates and a non-zero file size, so the map and large-asset surfaces are reachable.
 * Every asset is a member of the album.
 */
const newFixture = async (ctx: FixtureContext): Promise<Fixture> => {
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });

  const ids = {} as Record<AssetVisibility, string>;
  for (const [index, visibility] of ALL_VISIBILITIES.entries()) {
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility, localDateTime: BUCKET_DATE });
    await ctx.newExif({
      assetId: asset.id,
      latitude: 40.7128 + index,
      longitude: -74.006,
      fileSizeInByte: 1024 * (index + 1),
    });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
    ids[visibility] = asset.id;
  }

  return { userId: user.id, albumId: album.id, ids };
};

const authFor = (fixture: Fixture, elevated: boolean): AuthDto =>
  elevated
    ? factory.auth({ user: { id: fixture.userId }, session: { hasElevatedPermission: true } })
    : factory.auth({ user: { id: fixture.userId } });

/** A probe either reports which asset ids came back, or just how many rows were counted. */
type ProbeResult = { ids: string[] } | { count: number };

type Surface = {
  name: string;
  notElevated: AssetVisibility[];
  elevated: AssetVisibility[];
  run: (database: Kysely<DB>, elevated: boolean) => Promise<{ fixture: Fixture; result: ProbeResult }>;
};

const defineSurface = <S>(config: {
  name: string;
  setup: (database: Kysely<DB>) => { sut: S; ctx: FixtureContext };
  probe: (args: { sut: S; fixture: Fixture; auth: AuthDto }) => Promise<ProbeResult>;
  notElevated: AssetVisibility[];
  elevated: AssetVisibility[];
}): Surface => ({
  name: config.name,
  notElevated: config.notElevated,
  elevated: config.elevated,
  run: async (database, elevated) => {
    const { sut, ctx } = config.setup(database);
    const fixture = await newFixture(ctx);
    const auth = authFor(fixture, elevated);
    return { fixture, result: await config.probe({ sut, fixture, auth }) };
  },
});

const setupTimeline = (database: Kysely<DB>) =>
  newMediumService(TimelineService, {
    database,
    real: [AssetRepository, AccessRepository, PartnerRepository],
    mock: [LoggingRepository],
  });

const setupSearch = (database: Kysely<DB>) =>
  newMediumService(SearchService, {
    database,
    real: [
      AccessRepository,
      AssetRepository,
      DatabaseRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
    ],
    mock: [LoggingRepository],
  });

const setupAsset = (database: Kysely<DB>) =>
  newMediumService(AssetService, {
    database,
    real: [
      AssetRepository,
      AssetEditRepository,
      AssetJobRepository,
      AlbumRepository,
      AccessRepository,
      SharedLinkAssetRepository,
      StackRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, OcrRepository],
  });

const setupUser = (database: Kysely<DB>) =>
  newMediumService(UserService, {
    database,
    real: [AssetRepository, UserRepository],
    mock: [LoggingRepository, EventRepository, JobRepository, StorageRepository],
  });

const setupAlbum = (database: Kysely<DB>) =>
  newMediumService(AlbumService, {
    database,
    real: [AlbumRepository, UserRepository, AccessRepository, MapRepository],
    mock: [LoggingRepository, EventRepository],
  });

const setupMap = (database: Kysely<DB>) =>
  newMediumService(MapService, {
    database,
    real: [MapRepository, AlbumRepository, PartnerRepository],
    mock: [LoggingRepository],
  });

const setupDownload = (database: Kysely<DB>) =>
  newMediumService(DownloadService, {
    database,
    real: [DownloadRepository, UserRepository, AccessRepository],
    mock: [LoggingRepository, StorageRepository],
  });

const sumBucketCounts = (buckets: Array<{ count: number }>) =>
  buckets.reduce((total, bucket) => total + Number(bucket.count), 0);

/**
 * The matrix. `notElevated` / `elevated` list exactly the visibilities the surface returns today.
 * Annotations mark the cells that look wrong; they are asserted as-is on purpose.
 */
const SURFACES: Surface[] = [
  // Elevation is deliberately a no-op on the plain timeline and the global map. Widening them would
  // drop locked photos into the main Photos tab and onto the main map for the rest of the elevated
  // window, which is a privacy regression rather than a fix. The locked folder is reached by asking
  // for `visibility: locked` explicitly, which does require elevation. Album-scoped surfaces widen
  // because a locked album is, by construction, made only of locked assets.
  defineSurface({
    name: 'TimelineService.getTimeBuckets',
    setup: setupTimeline,
    probe: async ({ sut, auth }) => ({ count: sumBucketCounts(await sut.getTimeBuckets(auth, {})) }),
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive],
  }),
  defineSurface({
    name: 'TimelineService.getTimeBucket',
    setup: setupTimeline,
    probe: async ({ sut, auth }) => ({
      ids: JSON.parse(await sut.getTimeBucket(auth, { timeBucket: BUCKET_KEY })).id,
    }),
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive],
  }),
  defineSurface({
    name: 'TimelineService.getTimeBuckets (albumId)',
    setup: setupTimeline,
    probe: async ({ sut, fixture, auth }) => ({
      count: sumBucketCounts(await sut.getTimeBuckets(auth, { albumId: fixture.albumId })),
    }),
    notElevated: [Timeline, Archive],
    // The only surface that deliberately widens to Locked: `includeLockedAlbumAssets` in
    // `TimelineService.buildTimeBucketOptions` requires both an albumId and an elevated session.
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'TimelineService.getTimeBucket (albumId)',
    setup: setupTimeline,
    probe: async ({ sut, fixture, auth }) => ({
      ids: JSON.parse(await sut.getTimeBucket(auth, { albumId: fixture.albumId, timeBucket: BUCKET_KEY })).id,
    }),
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'SearchService.searchMetadata',
    setup: setupSearch,
    probe: async ({ sut, auth }) => {
      const response = await sut.searchMetadata(auth, {});
      return { ids: response.assets.items.map((item) => item.id) };
    },
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'SearchService.searchStatistics',
    setup: setupSearch,
    probe: async ({ sut, auth }) => {
      const statistics = await sut.searchStatistics(auth, {});
      return { count: statistics.total };
    },
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'SearchService.searchRandom',
    setup: setupSearch,
    probe: async ({ sut, auth }) => {
      const items = await sut.searchRandom(auth, {});
      return { ids: items.map((item) => item.id) };
    },
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'SearchService.searchLargeAssets',
    setup: setupSearch,
    probe: async ({ sut, auth }) => {
      const items = await sut.searchLargeAssets(auth, {});
      return { ids: items.map((item) => item.id) };
    },
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'AssetService.getStatistics',
    setup: setupAsset,
    probe: async ({ sut, auth }) => {
      const statistics = await sut.getStatistics(auth, {});
      return { count: statistics.total };
    },
    notElevated: [Timeline, Archive],
    // Agrees with SearchService.searchStatistics, which answers the same question. The two used to
    // disagree for an elevated session, 2 against 3, decided only by which endpoint the client called.
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'UserService.getCalendarHeatmap',
    setup: setupUser,
    probe: async ({ sut, auth }) => {
      const heatmap = await sut.getCalendarHeatmap(auth, { type: CalendarHeatmapType.Upload });
      return { count: heatmap.totalCount };
    },
    // Was the one surface with no visibility predicate at all, so it counted locked assets for a
    // session with no session object, and motion-photo parts inflated every total.
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'AlbumService.getMapMarkers',
    setup: setupAlbum,
    probe: async ({ sut, fixture, auth }) => {
      const markers = await sut.getMapMarkers(auth, fixture.albumId);
      return { ids: markers.map((marker) => marker.id) };
    },
    // `MapRepository.getAlbumMapMarkers` states its admitted set positively, so Hidden is excluded and
    // Locked requires elevation. Matches the album's own assetCount.
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'MapService.getMapMarkers',
    setup: setupMap,
    probe: async ({ sut, auth }) => {
      const markers = await sut.getMapMarkers(auth, {});
      return { ids: markers.map((marker) => marker.id) };
    },
    // The global map pins `visibility = 'timeline'` exactly, so it is the strictest surface here -
    // and the only one that hides Archive from its own owner.
    notElevated: [Timeline],
    elevated: [Timeline],
  }),
  defineSurface({
    name: 'AlbumService.get (assetCount)',
    setup: setupAlbum,
    probe: async ({ sut, fixture, auth }) => {
      const album = await sut.get(auth, fixture.albumId);
      return { count: album.assetCount };
    },
    // `getMetadataForIds` is passed the session's real elevation, so a Locked member is counted only
    // for an elevated session. This agrees with the album map markers on the very same album.
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'DownloadService.getDownloadInfo (own userId)',
    setup: setupDownload,
    probe: async ({ sut, fixture, auth }) => {
      const info = await sut.getDownloadInfo(auth, { userId: fixture.userId });
      return { ids: info.archives.flatMap((archive) => archive.assetIds) };
    },
    // `Permission.TimelineDownload` only checks that the requested id is the caller's own, so the
    // query itself has to exclude locked assets for a session that never entered the PIN.
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive, Locked],
  }),
];

describe('visibility matrix', () => {
  for (const surface of SURFACES) {
    for (const elevated of [false, true]) {
      const expected = elevated ? surface.elevated : surface.notElevated;
      const label = elevated ? 'elevated' : 'not elevated';

      it(`${surface.name} [${label}] returns exactly: ${expected.join(', ') || '(nothing)'}`, async () => {
        const { fixture, result } = await surface.run(defaultDatabase, elevated);

        if ('ids' in result) {
          const expectedIds = expected.map((visibility) => fixture.ids[visibility]);
          expect([...result.ids].sort()).toEqual([...expectedIds].sort());
        } else {
          expect(Number(result.count)).toBe(expected.length);
        }
      });
    }
  }
});
