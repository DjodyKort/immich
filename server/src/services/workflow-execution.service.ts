import { CurrentPlugin } from '@extism/extism';
import {
  AlbumAssetV1,
  WorkflowChanges,
  WorkflowEventData,
  WorkflowEventPayload,
  WorkflowResponse,
  WorkflowTrigger,
} from '@immich/plugin-sdk';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { join } from 'node:path';
import { DummyValue, OnEvent, OnJob } from 'src/decorators';
import { AlbumsAddAssetsDto, CreateAlbumDto, GetAlbumsDto } from 'src/dtos/album.dto';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { PluginManifestDto } from 'src/dtos/plugin-manifest.dto';
import { TagBulkAssetsDto } from 'src/dtos/tag.dto';
import {
  BootstrapEventPriority,
  DatabaseLock,
  ImmichEnvironment,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  SystemMetadataKey,
  WorkflowResult,
  WorkflowScanType,
  WorkflowType,
} from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { AlbumService } from 'src/services/album.service';
import { AssetService } from 'src/services/asset.service';
import { BaseService } from 'src/services/base.service';
import { TagService } from 'src/services/tag.service';
import { JobOf } from 'src/types';
import { withImpliedItems } from 'src/utils/workflow';

/** Sorts below every generated uuid, so it is the starting point for a paging cursor over a uuid column. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const dummy = () => {
  throw new Error(
    `Calling host functions is not allowed without setting methods[].hostFunctions=true in the plugin manifest`,
  );
};

type ExecuteOptions<T extends WorkflowType> = {
  read: (type: T) => Promise<{ authUserId: string; data: WorkflowEventData<T>; entityId?: string }>;
  write: (auth: AuthDto, changes: WorkflowChanges<T>) => Promise<void>;
};

type AssetTrigger = { userId: string; assetId: string; trigger: WorkflowTrigger };

type HostContext = {
  allowedHosts: string[];
};

export class WorkflowExecutionService extends BaseService {
  private jwtSecret!: string;
  private scanning = false;
  // Per-workflow, unlike `scanning`: the live scan is global and singular, but a backfill is requested
  // per workflow and two different workflows must be able to backfill at the same time.
  private backfilling = new Set<string>();

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.PluginSync, workers: [ImmichWorker.Microservices] })
  async onPluginSync() {
    await this.databaseRepository.withLock(DatabaseLock.PluginImport, async () => {
      // TODO avoid importing plugins in each worker
      // Can this use system metadata similar to geocoding?

      const { environment, resourcePaths, plugins } = this.configRepository.getEnv();
      await this.importFolder(resourcePaths.corePlugin, { force: environment === ImmichEnvironment.Development });

      if (plugins.external.allow && plugins.external.installFolder) {
        await this.importFolders(plugins.external.installFolder);
      }
    });
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.PluginSync, workers: [ImmichWorker.Microservices] })
  async onWorkflowCheckpointSeed() {
    // Claim a starting point before any album asset can be added, so the first scan has a checkpoint
    // older than the rows that triggered it. Seeding lazily inside the scan meant the first batch was
    // always skipped. Seeding to `now` rather than to the beginning of time is deliberate: existing album
    // members are not retroactively run through workflows.
    const checkpoint = await this.systemMetadataRepository.get(SystemMetadataKey.WorkflowCheckpoint);
    if (!checkpoint) {
      const { nowId } = await this.syncCheckpointRepository.getNow();
      await this.systemMetadataRepository.set(SystemMetadataKey.WorkflowCheckpoint, { albumAssetUuid: nowId });
    }
  }

  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.PluginLoad, workers: [ImmichWorker.Microservices] })
  async onPluginLoad() {
    this.jwtSecret = this.cryptoRepository.randomBytesAsText(32);

    const albumService = BaseService.create(AlbumService, this);
    const tagService = BaseService.create(TagService, this);

    const searchAlbums = this.wrap<[dto: GetAlbumsDto]>((authDto, ctx, args) => albumService.getAll(authDto, ...args));
    const createAlbum = this.wrap<[dto: CreateAlbumDto]>((authDto, ctx, args) => albumService.create(authDto, ...args));
    const addAssetsToAlbum = this.wrap<[id: string, dto: BulkIdsDto]>((authDto, ctx, args) =>
      albumService.addAssets(authDto, ...args),
    );
    const addAssetsToAlbums = this.wrap<[dto: AlbumsAddAssetsDto]>((authDto, ctx, args) =>
      albumService.addAssetsToAlbums(authDto, ...args),
    );
    const httpRequest = this.wrap<
      [
        url: string,
        options?: {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        },
      ]
    >(async (authDto, context, args) => {
      const hostname = new URL(args[0]).hostname;

      for (const pattern of context.allowedHosts) {
        const regex = new RegExp(pattern.replaceAll('.', String.raw`\.`).replaceAll('*', '.*'));
        if (regex.test(hostname)) {
          // eslint-disable-next-line unicorn/no-invalid-argument-count
          const res = await fetch(...args);

          return {
            ok: res.ok,
            status: res.status,
            body: await res.text(),
          };
        }
      }

      throw new Error('Hostname did not match any listed in methods[].allowedHosts in the plugin manifest');
    });
    const bulkTagAssets = this.wrap<[dto: TagBulkAssetsDto]>((authDto, ctx, args) =>
      tagService.bulkTagAssets(authDto, ...args),
    );

    const functions = {
      searchAlbums,
      createAlbum,
      addAssetsToAlbum,
      addAssetsToAlbums,
      httpRequest,
      bulkTagAssets,
    };

    const stubs: typeof functions = {
      searchAlbums: dummy,
      createAlbum: dummy,
      addAssetsToAlbum: dummy,
      addAssetsToAlbums: dummy,
      httpRequest: dummy,
      bulkTagAssets: dummy,
    };

    const plugins = await this.pluginRepository.getForLoad();
    for (const { id, name, version, wasmBytes, methods } of plugins) {
      const isMethod = methods.some(({ hostFunctions }) => !hostFunctions);
      if (isMethod) {
        const label = `${name}@${version}`;
        const key = this.getPluginKey({ id, hostFunctions: false });
        try {
          await this.pluginRepository.load({ key, label, wasmBytes }, { runInWorker: false, functions: stubs });
          this.logger.log(`Loaded plugin: ${label}`);
        } catch (error) {
          this.logger.error(`Unable to load plugin ${label} (${id})`, error);
        }
      }

      const isMethodWithFunction = methods.some(({ hostFunctions }) => hostFunctions);
      if (isMethodWithFunction) {
        const label = `${name}@${version}/worker`;
        const key = this.getPluginKey({ id, hostFunctions: true });
        try {
          await this.pluginRepository.load({ key, label, wasmBytes }, { runInWorker: true, functions });
          this.logger.log(`Loaded plugin with host functions: ${label}`);
        } catch (error) {
          this.logger.error(`Unable to load plugin with host functions ${label} (${id})`, error);
        }
      }
    }
  }

  private getPluginKey({ id, hostFunctions }: { id: string; hostFunctions: boolean }) {
    return id + (hostFunctions ? '/worker' : '');
  }

  private wrap<T>(fn: (authDto: AuthDto, context: HostContext, args: T) => Promise<unknown>) {
    return async (plugin: CurrentPlugin, offset: bigint) => {
      try {
        const handle = plugin.read(offset);
        if (!handle) {
          return plugin.store(
            JSON.stringify({ success: false, status: 400, message: 'Called host function without input' }),
          );
        }

        const { authToken, args } = handle.json() as { authToken: string; args: T };
        if (!authToken) {
          throw new Error('authToken is required');
        }

        const context = plugin.hostContext<HostContext>();
        const authDto = this.validate(authToken);
        const response = await fn(authDto, context, args);

        return plugin.store(JSON.stringify({ success: true, response }));
      } catch (error: Error | any) {
        if (error instanceof HttpException) {
          this.logger.error(`Plugin host exception: ${error}`);
          return plugin.store(
            JSON.stringify({ success: false, status: error.getStatus(), message: error.getResponse() }),
          );
        }

        this.logger.error(`Plugin host exception: ${error}`, error?.stack);

        return plugin.store(
          JSON.stringify({
            success: false,
            status: 500,
            message: `Internal server error: ${error}`,
          }),
        );
      }
    };
  }

  private async importFolders(installFolder: string): Promise<void> {
    try {
      const entries = await this.storageRepository.readdirWithTypes(installFolder);
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        await this.importFolder(join(installFolder, entry.name));
      }
    } catch (error) {
      this.logger.error(`Failed to import plugins folder ${installFolder}:`, error);
    }
  }

  private async importFolder(folder: string, options?: { force?: boolean }) {
    try {
      const manifestPath = join(folder, 'manifest.json');
      const bytes = await this.storageRepository.readFile(manifestPath);
      const contents = bytes.toString('utf8');
      const sha256hash = this.cryptoRepository.hashSha256(contents) as Buffer;

      if (!options?.force) {
        const match = await this.pluginRepository.getByHash(sha256hash);
        if (match) {
          this.logger.log(`Plugin up to date (name=${match.name}@${match.version}, hash=${sha256hash.toString('hex')}`);
          return;
        }
      }

      const dto = JSON.parse(contents);
      const result = PluginManifestDto.schema.safeParse(dto);
      if (!result.success) {
        const issues = result.error.issues.map((issue) => `  - [${issue.path.join('.')}] ${issue.message}`).join('\n');
        this.logger.warn(`Invalid plugin manifest at ${manifestPath}:\n${issues}`);
        return;
      }
      const manifest = result.data;

      const existing = await this.pluginRepository.getByName(manifest.name);
      const wasmPath = `${folder}/${manifest.wasmPath}`;
      const wasmBytes = await this.storageRepository.readFile(wasmPath);

      const plugin = await this.pluginRepository.upsert(
        {
          // NOTE: new properties here need to be added to the on conflict clause in the repository
          enabled: true,
          name: manifest.name,
          title: manifest.title,
          description: manifest.description,
          author: manifest.author,
          version: manifest.version,
          templates: manifest.templates,
          wasmBytes,
          sha256hash,
        },
        manifest.methods,
      );

      if (existing) {
        this.logger.log(
          `Upgraded plugin ${manifest.name} (${plugin.methods.length} methods) from ${existing.version} to ${manifest.version} `,
        );
      } else {
        this.logger.log(
          `Imported plugin ${manifest.name}@${manifest.version} (${plugin.methods.length} methods) from ${folder}`,
        );
      }

      return manifest;
    } catch {
      this.logger.warn(`Failed to import plugin from ${folder}:`);
    }
  }

  private validate(authToken: string): AuthDto {
    try {
      const jwt = this.cryptoRepository.verifyJwt<{ userId: string }>(authToken, this.jwtSecret);
      if (!jwt.userId) {
        throw new UnauthorizedException('Invalid token: missing userId');
      }

      return {
        user: {
          id: jwt.userId,
        },
      } as AuthDto;
    } catch (error) {
      this.logger.error('Token validation failed:', error);
      throw new UnauthorizedException('Invalid token');
    }
  }

  private sign(userId: string) {
    return this.cryptoRepository.signJwt({ userId }, this.jwtSecret);
  }

  @OnEvent({ name: 'AssetCreate' })
  onAssetCreate({ asset: { ownerId: userId, id: assetId } }: ArgOf<'AssetCreate'>) {
    return this.onAssetTrigger({ userId, assetId, trigger: WorkflowTrigger.AssetCreate });
  }

  @OnEvent({ name: 'AssetMetadataExtracted' })
  onAssetMetadataExtracted({ userId, assetId, source }: ArgOf<'AssetMetadataExtracted'>) {
    // prevent loops
    // TODO loop detection in job service directly
    if (source === 'sidecar-write') {
      return;
    }

    return this.onAssetTrigger({ userId, assetId, trigger: WorkflowTrigger.AssetMetadataExtraction });
  }

  @OnEvent({ name: 'AlbumAssetsAdded' })
  onAlbumAssetsAdded() {
    return this.jobRepository.queue({ name: JobName.WorkflowScan, data: { type: WorkflowScanType.AlbumAsset } });
  }

  @OnEvent({ name: 'AssetTag' })
  onAssetTagged({ assetId, userId }: ArgOf<'AssetTag'>) {
    return this.onAssetTrigger({ userId, assetId, trigger: WorkflowTrigger.AssetTagged });
  }

  private async onAssetTrigger({ userId, assetId, trigger }: AssetTrigger) {
    const items = await this.workflowRepository.search({ userId, trigger });
    await this.jobRepository.queueAll(
      items.map((workflow) => ({
        name: JobName.WorkflowAssetTrigger,
        data: { workflowId: workflow.id, assetId, trigger },
      })),
    );
  }

  @OnJob({ name: JobName.WorkflowScan, queue: QueueName.Workflow })
  private async scan({ type }: JobOf<JobName.WorkflowScan>) {
    if (this.scanning) {
      return JobStatus.Skipped;
    }

    if (type !== WorkflowScanType.AlbumAsset) {
      return;
    }

    // `scanning` is claimed after the type guard and released in a finally: an early return or a throw
    // used to leave it set, and every later scan then short-circuited as Skipped for the life of the
    // process, silently disabling the trigger.
    this.scanning = true;
    try {
      return await this.scanAlbumAssets();
    } finally {
      this.scanning = false;
    }
  }

  private async scanAlbumAssets() {
    // Seeded at bootstrap, so a missing checkpoint here means a database older than that change rather
    // than a fresh install. Seeding it to `now` and returning would skip the very batch that triggered
    // this scan, which is what used to make the feature look broken on first use.
    let checkpoint = await this.systemMetadataRepository.get(SystemMetadataKey.WorkflowCheckpoint);
    const now = await this.syncCheckpointRepository.getNow();

    if (!checkpoint) {
      checkpoint = { albumAssetUuid: now.nowId };
      await this.systemMetadataRepository.set(SystemMetadataKey.WorkflowCheckpoint, checkpoint);
    }

    const workflows = new Map();

    while (checkpoint.albumAssetUuid < now.nowId) {
      const albumAssets = await this.workflowRepository.getForAlbumAssetV1(checkpoint.albumAssetUuid);
      if (albumAssets.length === 0) {
        break;
      }

      const jobs = new Map<string, AlbumAssetV1[]>();
      for (const albumAsset of albumAssets) {
        const userId = albumAsset.asset?.ownerId;

        if (!workflows.has(userId)) {
          workflows.set(
            userId,
            await this.workflowRepository.search({ userId, trigger: WorkflowTrigger.AlbumAssetAdded }),
          );
        }

        for (const workflow of workflows.get(userId)) {
          if (!jobs.has(workflow.id)) {
            jobs.set(workflow.id, []);
          }

          jobs.get(workflow.id)!.push({ asset: albumAsset.asset as any, album: { id: albumAsset.albumId } });
        }
      }

      const queues = await this.workflowRepository.addToQueue(
        jobs
          .entries()
          .map(([workflowId, data]) => ({ workflowId, data }))
          .toArray(),
      );
      await this.jobRepository.queueAll(queues.map(({ id }) => ({ name: JobName.WorkflowRun, data: { queueId: id } })));

      // `getForAlbumAssetV1` orders by updateId ascending, so the batch's high-water mark is its LAST
      // row. Taking the first advanced the checkpoint by exactly one row per iteration and re-queued the
      // rest of the batch each time round: N + (N-1) + ... + 1 queue entries for a batch of N, up to about
      // two million for one full 2000-row page. Invisible in workflow_log because the repeat runs are
      // no-ops on an already-archived asset, so only workflow_queue showed it.
      checkpoint!.albumAssetUuid = albumAssets.at(-1)!.updateId;
      await this.systemMetadataRepository.set(SystemMetadataKey.WorkflowCheckpoint, checkpoint);
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.WorkflowBackfill, queue: QueueName.Workflow })
  private async backfill({ workflowId }: JobOf<JobName.WorkflowBackfill>) {
    if (this.backfilling.has(workflowId)) {
      return JobStatus.Skipped;
    }

    // Claimed before the async work and released in a finally, for the same reason `scanning` is: an
    // early return or a throw that skipped the release would leave this workflow permanently unable to
    // backfill again for the life of the process.
    this.backfilling.add(workflowId);
    try {
      return await this.backfillAlbumAssets(workflowId);
    } finally {
      this.backfilling.delete(workflowId);
    }
  }

  private async backfillAlbumAssets(workflowId: string) {
    const workflow = await this.workflowRepository.getForWorkflowRun(workflowId);
    if (!workflow) {
      // Deleted or disabled between enqueue and run. Nothing to backfill, and nothing to report as an
      // error -- the API entry point already rejected a disabled workflow at request time.
      return;
    }

    // `album_asset.updateId` is a uuid column, not text, so the starting cursor has to be a uuid that
    // sorts below every real one -- an empty string fails the query outright with `invalid input syntax
    // for type uuid: ""`, on the very first page of every backfill. TypeScript cannot see the difference
    // (both are `string`) and a mocked repository cannot either, so only a real database catches this.
    let cursor = NIL_UUID;
    while (true) {
      const albumAssets = await this.workflowRepository.getForAlbumAssetV1Backfill(workflow.ownerId, cursor);
      if (albumAssets.length === 0) {
        break;
      }

      const data: AlbumAssetV1[] = albumAssets.map((albumAsset) => ({
        asset: albumAsset.asset as any,
        album: { id: albumAsset.albumId },
      }));

      const queues = await this.workflowRepository.addToQueue([{ workflowId, data }]);
      await this.jobRepository.queueAll(queues.map(({ id }) => ({ name: JobName.WorkflowRun, data: { queueId: id } })));

      // Same reasoning as the comment in `scanAlbumAssets`: the batch's high-water mark is its LAST row
      // because `getForAlbumAssetV1Backfill` orders ascending by updateId. Taking the first row here
      // would reproduce the exact N + (N-1) + ... blowup that bug caused there.
      cursor = albumAssets.at(-1)!.updateId;
    }

    return JobStatus.Success;
  }

  private writeAssetV1<T extends WorkflowType>(assetId: string) {
    const assetService = BaseService.create(AssetService, this);

    return async (auth: AuthDto, changes: WorkflowChanges<T>) => {
      const asset = changes.asset;
      if (!asset) {
        return;
      }

      await assetService.update(auth, assetId, {
        isFavorite: asset.isFavorite,
        visibility: asset.visibility,
        dateTimeOriginal: asset.exifInfo?.dateTimeOriginal ?? undefined,
        // TODO allow setting to null
        longitude: asset.exifInfo?.longitude ?? undefined,
        // TODO allow setting to null
        latitude: asset.exifInfo?.latitude ?? undefined,
        // TODO allow setting to null
        description: asset.exifInfo?.description ?? undefined,
        rating: asset.exifInfo?.rating,

        // TODO add to update dto
        // make: asset.exifInfo?.make,
        // model: asset.exifInfo?.model,
        // city: asset.exifInfo?.city,
        // state: asset.exifInfo?.state,
        // country: asset.exifInfo?.country,
        // lensModel: asset.exifInfo?.lensModel,
        // fNumber: asset.exifInfo?.fNumber,
        // fps: asset.exifInfo?.fps,
        // iso: asset.exifInfo?.iso,
      });
    };
  }

  @OnJob({ name: JobName.WorkflowAssetTrigger, queue: QueueName.Workflow })
  handleAssetTrigger({ workflowId, assetId }: JobOf<JobName.WorkflowAssetTrigger>) {
    return this.execute(workflowId, (type) => {
      switch (type) {
        case WorkflowType.AssetV1: {
          return {
            read: async () => {
              const asset = await this.workflowRepository.getForAssetV1(assetId);
              return {
                data: { asset } as any,
                authUserId: asset.ownerId,
                entityId: asset.id,
              };
            },
            write: this.writeAssetV1<typeof type>(assetId),
          } satisfies ExecuteOptions<typeof type>;
        }
        default: {
          return;
        }
      }
    });
  }

  @OnJob({ name: JobName.WorkflowRun, queue: QueueName.Workflow })
  async runQueue({ queueId }: JobOf<JobName.WorkflowRun>) {
    const queue = await this.workflowRepository.getQueue(queueId);

    for (const item of queue.data) {
      await this.execute(queue.workflowId, (type) => {
        switch (type) {
          case WorkflowType.AssetV1:
          case WorkflowType.AlbumAssetV1: {
            return {
              read: async () => {
                const workflow = await this.workflowRepository.getForWorkflowRun(queue.workflowId);
                return {
                  data: item as any,
                  authUserId: workflow!.ownerId,
                };
              },
              write: async (auth, changes) => {
                const workflow = await this.workflowRepository.getForWorkflowRun(queue.workflowId);
                if ((item as AlbumAssetV1).asset.ownerId === workflow?.ownerId) {
                  await this.writeAssetV1<typeof type>((item as AlbumAssetV1).asset.id)(auth, changes);
                }
              },
            } satisfies ExecuteOptions<typeof type>;
          }
          default: {
            return;
          }
        }
      });
    }
  }

  private async execute<T extends WorkflowType>(
    workflowId: string,
    getHandler: (type: T) => ExecuteOptions<T> | undefined,
  ) {
    const workflow = await this.workflowRepository.getForWorkflowRun(workflowId);
    if (!workflow) {
      return;
    }

    // TODO infer from steps
    let type: T | undefined;
    for (const targetType of Object.values(WorkflowType)) {
      const implied = withImpliedItems(targetType);
      const isMissing = workflow.steps.some((step) => step.types.every((type) => !implied.includes(type)));
      if (!isMissing) {
        type = targetType as unknown as T;
        break;
      }
    }

    if (!type) {
      throw new Error('Unable to infer workflow event type from steps');
    }

    const handler = getHandler(type);
    if (!handler) {
      this.logger.error(`Misconfigured workflow ${workflowId}: no handler for type ${type}`);
      return;
    }

    const { read, write } = handler;
    const readResult = await read(type);
    let data = readResult.data;
    const runId = crypto.randomUUID();

    for (const step of workflow.steps) {
      try {
        const payload: WorkflowEventPayload<typeof type> = {
          trigger: workflow.trigger,
          type,
          config: step.config ?? {},
          workflow: {
            id: workflowId,
            authToken: this.sign(readResult.authUserId),
            stepId: step.id,
          },
          data,
        };

        const context: HostContext = {
          allowedHosts: step.allowedHosts,
        };

        if (step.methodName.startsWith('noop')) {
          continue;
        }

        const result = await this.pluginRepository.callMethod<WorkflowResponse<T>>(
          {
            pluginKey: this.getPluginKey({ id: step.pluginId, hostFunctions: step.hostFunctions }),
            methodName: step.methodName,
          },
          payload,
          context,
        );
        if (result?.changes) {
          await write(
            {
              user: {
                id: readResult.authUserId,
              },
              session: {
                id: DummyValue.UUID,
                hasElevatedPermission: true,
              },
            } as AuthDto,
            result.changes,
          );
          ({ data } = await read(type));
        }

        if (result?.config) {
          await this.workflowRepository.updateStep(step.id, { config: result.config });
        }

        const shouldContinue = result?.workflow?.continue ?? true;
        if (!shouldContinue) {
          if (workflow.logging) {
            await this.workflowRepository.log({
              workflowId,
              result: WorkflowResult.Halted,
              workflowStepId: step.id,
              triggerDataId: readResult.entityId,
              runId,
            });
          }

          this.logger.debug(`Workflow ${workflowId} run ${runId} stopped on step ${step.id}`);
          return;
        }
      } catch (error) {
        this.logger.error(`Error executing workflow ${workflowId} run ${runId}:`, error);

        if (workflow.logging) {
          await this.workflowRepository.log({
            workflowId,
            result: WorkflowResult.Error,
            workflowStepId: step.id,
            triggerDataId: readResult.entityId,
            runId,
          });
        }

        return JobStatus.Failed;
      }
    }

    if (workflow.logging) {
      await this.workflowRepository.log({
        workflowId,
        result: WorkflowResult.Completed,
        triggerDataId: readResult.entityId,
        runId,
      });
    }

    this.logger.debug(`Workflow ${workflowId} run ${runId} executed successfully`);
  }
}
