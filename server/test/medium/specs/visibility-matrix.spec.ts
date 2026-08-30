import { Kysely } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto';
import { SearchSuggestionType } from 'src/dtos/search.dto';
import { AssetStatus, AssetSurface, AssetVisibility, CalendarHeatmapType } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository';
import { AssetJobRepository } from 'src/repositories/asset-job.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { DownloadRepository } from 'src/repositories/download.repository';
import { DuplicateRepository } from 'src/repositories/duplicate.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MapRepository } from 'src/repositories/map.repository';
import { MemoryRepository } from 'src/repositories/memory.repository';
import { OcrRepository } from 'src/repositories/ocr.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { SearchRepository } from 'src/repositories/search.repository';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { ViewRepository } from 'src/repositories/view-repository';
import { DB } from 'src/schema';
import { AlbumService } from 'src/services/album.service';
import { AssetService } from 'src/services/asset.service';
import { DownloadService } from 'src/services/download.service';
import { DuplicateService } from 'src/services/duplicate.service';
import { MapService } from 'src/services/map.service';
import { MemoryService } from 'src/services/memory.service';
import { PersonService } from 'src/services/person.service';
import { SearchService } from 'src/services/search.service';
import { StackService } from 'src/services/stack.service';
import { TimelineService } from 'src/services/timeline.service';
import { UserService } from 'src/services/user.service';
import { ViewService } from 'src/services/view.service';
import { getSurfaceBit, Surface as PolicySurface } from 'src/utils/visibility-policy';
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
  /** One person, with a visible face on every asset, for the people surface. */
  personGroupId: string;
  /** One memory, containing every asset, for the memories surface. */
  memoryId: string;
  /** Shared by all four assets, so that they form a single duplicate group. */
  duplicateId: string;
  /** asset id, per visibility */
  ids: Record<AssetVisibility, string>;
};

type FixtureContext = Pick<
  MediumTestContext,
  | 'newUser'
  | 'newAlbum'
  | 'newAsset'
  | 'newExif'
  | 'newAlbumAsset'
  | 'newPerson'
  | 'newAssetFace'
  | 'newMemory'
  | 'newMemoryAsset'
  | 'newStack'
>;

/**
 * Every asset shares this directory, because it is assetInsert's default originalPath, so the folder
 * view can be probed without the fixture inventing a path scheme of its own.
 */
const FOLDER_PATH = '/path/to';

/**
 * One user, one ordinary (non-locked) album, one person, one memory, and one asset per visibility -
 * each with an EXIF row carrying coordinates, a distinct city, and a non-zero file size, so the map,
 * large-asset, and search-suggestion surfaces are reachable. Every asset is a member of the album and
 * of the memory, carries a visible face of the person, and shares one duplicateId, so the four form a
 * single duplicate group.
 *
 * Those extras are inert for the surfaces that do not read them: no surface filters on duplicateId, on
 * originalPath, on the EXIF city, or on face membership, and the person is not hidden, which is the
 * only thing the memories query asks about a face. Nothing here puts the assets in a stack - a stack
 * hides its non-primary members from the timeline, which would move cells recorded before this file
 * existed.
 */
const newFixture = async (ctx: FixtureContext): Promise<Fixture> => {
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  const { person } = await ctx.newPerson({ ownerId: user.id });
  const { memory } = await ctx.newMemory({ ownerId: user.id });
  const duplicateId = factory.uuid();

  const ids = {} as Record<AssetVisibility, string>;
  for (const [index, visibility] of ALL_VISIBILITIES.entries()) {
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      visibility,
      localDateTime: BUCKET_DATE,
      duplicateId,
    });
    await ctx.newExif({
      assetId: asset.id,
      latitude: 40.7128 + index,
      longitude: -74.006,
      fileSizeInByte: 1024 * (index + 1),
      city: 'City ' + index,
    });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
    await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });
    ids[visibility] = asset.id;
  }

  return {
    userId: user.id,
    albumId: album.id,
    personGroupId: person.personGroupId,
    memoryId: memory.id,
    duplicateId,
    ids,
  };
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
  /** Rows this surface needs that would perturb the other surfaces if the base fixture created them. */
  extend?: (args: { ctx: FixtureContext; fixture: Fixture }) => Promise<void>;
  notElevated: AssetVisibility[];
  elevated: AssetVisibility[];
}): Surface => ({
  name: config.name,
  notElevated: config.notElevated,
  elevated: config.elevated,
  run: async (database, elevated) => {
    const { sut, ctx } = config.setup(database);
    const fixture = await newFixture(ctx);
    await config.extend?.({ ctx, fixture });
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

const setupPerson = (database: Kysely<DB>) =>
  newMediumService(PersonService, {
    database,
    real: [PersonRepository, AccessRepository],
    mock: [LoggingRepository],
  });

const setupMemory = (database: Kysely<DB>) =>
  newMediumService(MemoryService, {
    database,
    real: [MemoryRepository, AccessRepository],
    mock: [LoggingRepository],
  });

const setupView = (database: Kysely<DB>) =>
  newMediumService(ViewService, {
    database,
    real: [ViewRepository],
    mock: [LoggingRepository],
  });

const setupDuplicate = (database: Kysely<DB>) =>
  newMediumService(DuplicateService, {
    database,
    real: [DuplicateRepository, AccessRepository],
    mock: [LoggingRepository],
  });

const setupStack = (database: Kysely<DB>) =>
  newMediumService(StackService, {
    database,
    real: [StackRepository, AccessRepository],
    mock: [LoggingRepository, EventRepository],
  });

const sumBucketCounts = (buckets: Array<{ count: number }>) =>
  buckets.reduce((total, bucket) => total + Number(bucket.count), 0);

/** A person's asset count. A helper because lint forbids reading a member straight off an await. */
const personAssetCount = async (sut: PersonService, auth: AuthDto, personGroupId: string) => {
  const { assets } = await sut.getStatistics(auth, personGroupId);
  return assets;
};

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
    // An album-scoped bucket query asks the policy table for `Surface.AlbumTimeline`, which widens to
    // Locked on elevation, where the plain timeline above asks for `Surface.Timeline`, which never
    // does. The albumId in the request is the only thing that chooses between the two.
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
      const response = await sut.searchMetadata(auth, { size: 100 });
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
      const items = await sut.searchRandom(auth, { size: 100 });
      return { ids: items.map((item) => item.id) };
    },
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive, Locked],
  }),
  defineSurface({
    name: 'SearchService.searchLargeAssets',
    setup: setupSearch,
    probe: async ({ sut, auth }) => {
      const items = await sut.searchLargeAssets(auth, { size: 100 });
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

  // The surfaces below pin `Surface.People`, `Surface.Memories`, `Surface.FolderView`,
  // `Surface.SearchSuggestions`, `Surface.AlbumContents`, `Surface.Duplicates`, and
  // `Surface.StackContents`. None of them widens on elevation, which is what they did before the
  // policy layer reached them: the first four asked for `visibility = 'timeline'` exactly, and the
  // last three shared `withDefaultVisibility`, which had no way to ask about elevation at all.
  defineSurface({
    name: 'PersonService.getStatistics',
    setup: setupPerson,
    probe: async ({ sut, fixture, auth }) => {
      const statistics = await sut.getStatistics(auth, fixture.personGroupId);
      return { count: statistics.assets };
    },
    // The strictest rule in the table alongside the global map: a person's asset count omits the
    // owner's own archived photos, so archiving a face's only photo makes the person read as empty.
    notElevated: [Timeline],
    elevated: [Timeline],
  }),
  // The two probes below are the count above's contents. They are here because their absence is what
  // let a real bug ship: `timelineSurfaceFor` had no `personId` branch, so a person's grid fell through
  // to `Surface.Timeline` and read the timeline's hide bit. The count and the grid then disagreed in
  // both directions -- a photo hidden from the timeline vanished from the grid while still being
  // counted, and one hidden from People stayed in the grid while dropping out of the count. Any probe
  // that reports a count needs its contents probed beside it, or half the surface is untested.
  defineSurface({
    name: 'TimelineService.getTimeBuckets (personId)',
    setup: setupTimeline,
    probe: async ({ sut, fixture, auth }) => ({
      count: sumBucketCounts(await sut.getTimeBuckets(auth, { personId: fixture.personGroupId })),
    }),
    // Identical to PersonService.getStatistics directly above, which is the point: the header count and
    // the grid beneath it must admit exactly the same assets.
    notElevated: [Timeline],
    elevated: [Timeline],
  }),
  defineSurface({
    name: 'TimelineService.getTimeBucket (personId)',
    setup: setupTimeline,
    probe: async ({ sut, fixture, auth }) => ({
      ids: JSON.parse(await sut.getTimeBucket(auth, { personId: fixture.personGroupId, timeBucket: BUCKET_KEY })).id,
    }),
    notElevated: [Timeline],
    elevated: [Timeline],
  }),
  defineSurface({
    name: 'MemoryService.search',
    setup: setupMemory,
    probe: async ({ sut, auth }) => {
      const memories = await sut.search(auth, {});
      return { ids: memories.flatMap((memory) => memory.assets.map((asset) => asset.id)) };
    },
    notElevated: [Timeline],
    elevated: [Timeline],
  }),
  defineSurface({
    name: 'ViewService.getAssetsByOriginalPath',
    setup: setupView,
    probe: async ({ sut, auth }) => {
      const assets = await sut.getAssetsByOriginalPath(auth, FOLDER_PATH);
      return { ids: assets.map((asset) => asset.id) };
    },
    notElevated: [Timeline],
    elevated: [Timeline],
  }),
  defineSurface({
    name: 'SearchService.getSearchSuggestions (city)',
    setup: setupSearch,
    probe: async ({ sut, auth }) => {
      // One distinct city per asset, so the number of suggestions is the number of admitted assets.
      const suggestions = await sut.getSearchSuggestions(auth, { type: SearchSuggestionType.CITY });
      return { count: suggestions.length };
    },
    notElevated: [Timeline],
    elevated: [Timeline],
  }),
  defineSurface({
    name: 'AlbumService.update (assetCount)',
    setup: setupAlbum,
    probe: async ({ sut, fixture, auth }) => {
      // mapAlbum derives assetCount from the album's own asset list, so this counts Surface.AlbumContents
      // rather than Surface.AlbumMetadata, which is what AlbumService.get reports under the same name.
      const album = await sut.update(auth, fixture.albumId, { albumName: 'renamed' });
      return { count: album.assetCount };
    },
    // Deliberately narrower than `AlbumService.get (assetCount)` above, which widens to Locked on
    // elevation while this does not - the same response field, decided by two different rules. The
    // disagreement is recorded here rather than resolved, so whichever commit reconciles them has to
    // move a cell on purpose.
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive],
  }),
  defineSurface({
    name: 'DuplicateService.getDuplicates',
    setup: setupDuplicate,
    probe: async ({ sut, auth }) => {
      const groups = await sut.getDuplicates(auth);
      return { ids: groups.flatMap((group) => group.assets.map((asset) => asset.id)) };
    },
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive],
  }),
  defineSurface({
    name: 'StackService.search',
    setup: setupStack,
    // A stack is created only for this surface: a stack hides its non-primary members from the
    // timeline, so putting one in the base fixture would move cells on unrelated surfaces.
    extend: async ({ ctx, fixture }) => {
      await ctx.newStack(
        { ownerId: fixture.userId },
        ALL_VISIBILITIES.map((visibility) => fixture.ids[visibility]),
      );
    },
    probe: async ({ sut, auth }) => {
      const stacks = await sut.search(auth, {});
      return { ids: stacks.flatMap((stack) => stack.assets.map((asset) => asset.id)) };
    },
    notElevated: [Timeline, Archive],
    elevated: [Timeline, Archive],
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

describe('per-asset exclusions', () => {
  // The justification for asset.hiddenFrom. POLICY gives per-*surface* rules, but one exclusive enum can
  // never express "hide this single photo from one surface and leave it on the others". If these two ever
  // pass trivially, the column is dead weight.
  it('should hide an asset from only the surface its mask names', async () => {
    const { sut: timeline, ctx } = setupTimeline(defaultDatabase);
    const { user } = await ctx.newUser();
    const { asset: kept } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    const { asset: excluded } = await ctx.newAsset({
      ownerId: user.id,
      visibility: AssetVisibility.Timeline,
      hiddenFrom: getSurfaceBit(PolicySurface.Timeline),
    });
    const auth = factory.auth({ user: { id: user.id } });

    const buckets = await timeline.getTimeBuckets(auth, {});
    expect(buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(1);

    const { sut: search } = setupSearch(defaultDatabase);
    const found = await search.searchMetadata(auth, { size: 100 });
    const ids = found.assets.items.map((item) => item.id);

    // Off the timeline, still findable in search. This is the capability the enum could not carry.
    expect(ids).toContain(excluded.id);
    expect(ids).toContain(kept.id);
  });

  /**
   * The same capability, driven through the API instead of a hand-written mask. `AssetService` is the only
   * writer, `AssetSurface` is the only vocabulary on the wire, and `toHiddenFromMask` is the only
   * translation -- so these assert that the enforcement above is actually reachable by a client.
   */
  it('should hide an asset from People only, when asked through AssetService.update', async () => {
    const { sut: assetService, ctx } = setupAsset(defaultDatabase);
    const { user } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: user.id });
    const { asset: kept } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    const { asset: excluded } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    for (const asset of [kept, excluded]) {
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1024 });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    }
    const auth = factory.auth({ user: { id: user.id } });

    const { sut: personService } = setupPerson(defaultDatabase);
    expect(await personAssetCount(personService, auth, person.personGroupId)).toBe(2);

    const response = await assetService.update(auth, excluded.id, { hiddenFrom: [AssetSurface.People] });
    // The wire format is surface names in both directions; the mask never leaves the server.
    expect(response.hiddenFrom).toEqual([AssetSurface.People]);

    expect(await personAssetCount(personService, auth, person.personGroupId)).toBe(1);

    // Still on the timeline and still findable in search: only the surface named moved.
    const { sut: timeline } = setupTimeline(defaultDatabase);
    expect(sumBucketCounts(await timeline.getTimeBuckets(auth, {}))).toBe(2);

    // And the person's own grid agrees with the count above it. This assertion is the one that was
    // missing: the count dropped to 1 while the grid still returned both, because the grid was reading
    // the timeline's bit.
    expect(sumBucketCounts(await timeline.getTimeBuckets(auth, { personId: person.personGroupId }))).toBe(1);

    const { sut: search } = setupSearch(defaultDatabase);
    const found = await search.searchMetadata(auth, { size: 100 });
    expect(found.assets.items.map((item) => item.id)).toContain(excluded.id);
  });

  it('should keep an asset in the person grid when it is hidden from the timeline only', async () => {
    // The reported bug, end to end. An album set to hide its members from the timeline pushed the
    // inherited mask onto 22 assets; the person's header read 22 and the grid rendered nothing. Hiding
    // from the timeline is a statement about the main grid and says nothing about People.
    const { sut: assetService, ctx } = setupAsset(defaultDatabase);
    const { user } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: user.id });
    const newTimelineAsset = () =>
      ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline, localDateTime: BUCKET_DATE });
    const { asset: kept } = await newTimelineAsset();
    const { asset: hidden } = await newTimelineAsset();
    for (const asset of [kept, hidden]) {
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1024 });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    }
    const auth = factory.auth({ user: { id: user.id } });

    await assetService.update(auth, hidden.id, { hiddenFrom: [AssetSurface.Timeline] });

    const { sut: timeline } = setupTimeline(defaultDatabase);
    expect(sumBucketCounts(await timeline.getTimeBuckets(auth, {}))).toBe(1);

    // Both still here, and the count says so too.
    const { sut: personService } = setupPerson(defaultDatabase);
    expect(await personAssetCount(personService, auth, person.personGroupId)).toBe(2);
    expect(sumBucketCounts(await timeline.getTimeBuckets(auth, { personId: person.personGroupId }))).toBe(2);

    const ids = JSON.parse(
      await timeline.getTimeBucket(auth, { personId: person.personGroupId, timeBucket: BUCKET_KEY }),
    ).id;
    expect(ids).toEqual(expect.arrayContaining([hidden.id]));
  });

  it('should clear every exclusion when AssetService.update is given null', async () => {
    const { sut: assetService, ctx } = setupAsset(defaultDatabase);
    const { user } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1024 });
    await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    const auth = factory.auth({ user: { id: user.id } });

    const { sut: personService } = setupPerson(defaultDatabase);
    await assetService.update(auth, asset.id, { hiddenFrom: [AssetSurface.People] });
    expect(await personAssetCount(personService, auth, person.personGroupId)).toBe(0);

    const cleared = await assetService.update(auth, asset.id, { hiddenFrom: null });
    expect(cleared.hiddenFrom).toEqual([]);
    expect(await personAssetCount(personService, auth, person.personGroupId)).toBe(1);
  });

  it('should replace the whole set rather than merge into it', async () => {
    const { sut: assetService, ctx } = setupAsset(defaultDatabase);
    const { user } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1024 });
    await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    const auth = factory.auth({ user: { id: user.id } });

    const { sut: personService } = setupPerson(defaultDatabase);
    const { sut: timeline } = setupTimeline(defaultDatabase);

    await assetService.update(auth, asset.id, { hiddenFrom: [AssetSurface.People, AssetSurface.Timeline] });
    expect(await personAssetCount(personService, auth, person.personGroupId)).toBe(0);
    expect(sumBucketCounts(await timeline.getTimeBuckets(auth, {}))).toBe(0);

    // Timeline is absent from the second call, so it must come back -- a merge would leave it excluded.
    const narrowed = await assetService.update(auth, asset.id, { hiddenFrom: [AssetSurface.People] });
    expect(narrowed.hiddenFrom).toEqual([AssetSurface.People]);
    expect(await personAssetCount(personService, auth, person.personGroupId)).toBe(0);
    expect(sumBucketCounts(await timeline.getTimeBuckets(auth, {}))).toBe(1);
  });

  it('should apply to every asset named by AssetService.updateAll', async () => {
    const { sut: assetService, ctx } = setupAsset(defaultDatabase);
    const { user } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: user.id });
    const { asset: first } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    const { asset: untouched } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    for (const asset of [first, second, untouched]) {
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1024 });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    }
    const auth = factory.auth({ user: { id: user.id } });

    // updateAll queues a sidecar write per asset; the mocked JobRepository is strict.
    ctx.getMock(JobRepository).queueAll.mockResolvedValue();

    await assetService.updateAll(auth, { ids: [first.id, second.id], hiddenFrom: [AssetSurface.People] });

    const { sut: personService } = setupPerson(defaultDatabase);
    expect(await personAssetCount(personService, auth, person.personGroupId)).toBe(1);

    const { sut: timeline } = setupTimeline(defaultDatabase);
    expect(sumBucketCounts(await timeline.getTimeBuckets(auth, {}))).toBe(3);
  });

  it('should still show a timeline-hidden asset in trash, so it stays recoverable', async () => {
    // The trash view asks the bucket queries with isTrashed and no explicit visibility. Before
    // Surface.Trash existed it inherited the timeline's rule, mask included, so hiding a photo from the
    // timeline quietly made it unrecoverable through the UI. Surface.Trash has no entry in SURFACE_BIT.
    const { sut, ctx } = setupTimeline(defaultDatabase);
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      visibility: AssetVisibility.Timeline,
      hiddenFrom: getSurfaceBit(PolicySurface.Timeline),
      deletedAt: new Date(),
      status: AssetStatus.Trashed,
    });
    const auth = factory.auth({ user: { id: user.id } });

    const visible = await sut.getTimeBuckets(auth, {});
    expect(visible.reduce((total, bucket) => total + bucket.count, 0)).toBe(0);

    const trashed = await sut.getTimeBuckets(auth, { isTrashed: true });
    expect(trashed.reduce((total, bucket) => total + bucket.count, 0)).toBe(1);
    expect(asset.id).toBeDefined();
  });

  it('should leave a null mask behaving exactly as before', async () => {
    // Every row upstream writes has hiddenFrom null, so this guards "additive means additive".
    const { sut, ctx } = setupTimeline(defaultDatabase);
    const { user } = await ctx.newUser();
    await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
    const auth = factory.auth({ user: { id: user.id } });

    const buckets = await sut.getTimeBuckets(auth, {});
    expect(buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(2);
  });
});
