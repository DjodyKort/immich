import { WorkflowTrigger } from '@immich/plugin-sdk';
import { Kysely } from 'kysely';
import { JobName, JobStatus } from 'src/enum';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { WorkflowRepository } from 'src/repositories/workflow.repository';
import { DB } from 'src/schema';
import { WorkflowExecutionService } from 'src/services/workflow-execution.service';
import { newMediumService } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';
import { Mocked } from 'vitest';

/**
 * The backfill applies an existing `AlbumAssetAdded` workflow to album members that predate it.
 *
 * This runs against a real database on purpose. The unit suite mocks `WorkflowRepository`, so it can
 * assert which cursor the service passes but not whether Postgres will accept it -- and the paging
 * cursor is a uuid column compared against a plain `string`. The original implementation started that
 * cursor at `''`, which type-checks, passes a mocked unit test, and then fails every real backfill on
 * its first page with `invalid input syntax for type uuid: ""`. That class of bug is only reachable
 * from here.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(WorkflowExecutionService, {
    database: db || defaultDatabase,
    real: [WorkflowRepository],
    mock: [LoggingRepository, JobRepository],
  });

  // Mocked dependencies are constructed inline by the factory rather than cached, so `ctx.get` would
  // hand back a *real* repository instead. The service's own field is the mock.
  const jobMock = sut['jobRepository'] as Mocked<JobRepository>;

  // The mock factory throws on any call with no implementation, so the queue call needs one even
  // though nothing here inspects its return value.
  jobMock.queueAll.mockResolvedValue();

  return { sut, ctx, jobMock };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(`${WorkflowExecutionService.name} backfill`, () => {
  it('should enqueue an album asset that already existed when the workflow was created', async () => {
    const { sut, ctx, jobMock } = setup();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

    const workflow = await ctx
      .get(WorkflowRepository)
      .create({ ownerId: user.id, trigger: WorkflowTrigger.AlbumAssetAdded });

    await expect(sut['backfill']({ workflowId: workflow.id })).resolves.toBe(JobStatus.Success);

    // The queue row is the contract with the existing run path: the backfill only enumerates, and
    // `WorkflowRun` is what actually applies the workflow's own filters and actions.
    const queued = await ctx.database
      .selectFrom('workflow_queue')
      .selectAll()
      .where('workflowId', '=', workflow.id)
      .execute();

    expect(queued).toHaveLength(1);
    expect(queued[0].data).toEqual([{ asset: expect.objectContaining({ id: asset.id }), album: { id: album.id } }]);
    expect(jobMock.queueAll).toHaveBeenCalledWith([{ name: JobName.WorkflowRun, data: { queueId: queued[0].id } }]);
  });

  it('should do nothing for a workflow with no existing album assets', async () => {
    const { sut, ctx, jobMock } = setup();
    const { user } = await ctx.newUser();
    const workflow = await ctx
      .get(WorkflowRepository)
      .create({ ownerId: user.id, trigger: WorkflowTrigger.AlbumAssetAdded });

    await expect(sut['backfill']({ workflowId: workflow.id })).resolves.toBe(JobStatus.Success);

    expect(jobMock.queueAll).not.toHaveBeenCalled();
  });

  it('should terminate rather than page forever', async () => {
    const { sut, ctx, jobMock } = setup();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    for (let i = 0; i < 3; i++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
    }

    const workflow = await ctx
      .get(WorkflowRepository)
      .create({ ownerId: user.id, trigger: WorkflowTrigger.AlbumAssetAdded });

    await expect(sut['backfill']({ workflowId: workflow.id })).resolves.toBe(JobStatus.Success);

    // One page, then an empty page that ends the loop. A cursor that failed to advance past the batch
    // would re-read the same rows forever, so reaching this assertion at all is the real check.
    expect(jobMock.queueAll).toHaveBeenCalledTimes(1);
    const queued = await ctx.database
      .selectFrom('workflow_queue')
      .selectAll()
      .where('workflowId', '=', workflow.id)
      .execute();
    expect(queued).toHaveLength(1);
    expect(queued[0].data).toHaveLength(3);
  });
});
