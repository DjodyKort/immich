import { WorkflowTrigger } from '@immich/plugin-sdk';
import { JobName, JobStatus } from 'src/enum';
import { WorkflowExecutionService } from 'src/services/workflow-execution.service';
import { newTestService, ServiceMocks } from 'test/utils';

describe(WorkflowExecutionService.name, () => {
  let sut: WorkflowExecutionService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(WorkflowExecutionService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('backfill', () => {
    const workflowId = 'workflow-1';
    const workflowRun = {
      id: workflowId,
      name: 'test workflow',
      trigger: WorkflowTrigger.AlbumAssetAdded,
      ownerId: 'owner-1',
      logging: false,
      steps: [],
    };

    it('should do nothing when the workflow is missing or disabled', async () => {
      mocks.workflow.getForWorkflowRun.mockResolvedValue(undefined);

      const result = await sut['backfill']({ workflowId });

      expect(result).toBeUndefined();
      expect(mocks.workflow.getForAlbumAssetV1Backfill).not.toHaveBeenCalled();
      expect(mocks.workflow.addToQueue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should skip a concurrent backfill of the same workflow', async () => {
      const { promise, resolve: resolveWorkflow } = Promise.withResolvers<typeof workflowRun>();
      mocks.workflow.getForWorkflowRun.mockImplementation(() => promise);
      mocks.workflow.getForAlbumAssetV1Backfill.mockResolvedValue([]);

      const first = sut['backfill']({ workflowId });
      // The guard is claimed synchronously before the first await, so the second call sees it
      // immediately without needing to wait on the in-flight run.
      await expect(sut['backfill']({ workflowId })).resolves.toBe(JobStatus.Skipped);

      resolveWorkflow(workflowRun);
      await first;

      expect(mocks.workflow.getForWorkflowRun).toHaveBeenCalledTimes(1);
    });

    it('should release the guard after a throw, so a later run is not skipped', async () => {
      mocks.workflow.getForWorkflowRun.mockRejectedValueOnce(new Error('boom'));

      await expect(sut['backfill']({ workflowId })).rejects.toThrow('boom');

      mocks.workflow.getForWorkflowRun.mockResolvedValueOnce(undefined);

      await expect(sut['backfill']({ workflowId })).resolves.toBeUndefined();
      expect(mocks.workflow.getForWorkflowRun).toHaveBeenCalledTimes(2);
    });

    it('should advance the cursor to the LAST row of a batch, not the first', async () => {
      mocks.workflow.getForWorkflowRun.mockResolvedValue(workflowRun);

      const batch = [
        { albumId: 'album-1', assetId: 'asset-1', updateId: 'cursor-a', asset: { id: 'asset-1' } },
        { albumId: 'album-1', assetId: 'asset-2', updateId: 'cursor-b', asset: { id: 'asset-2' } },
      ];
      mocks.workflow.getForAlbumAssetV1Backfill.mockResolvedValueOnce(batch as any).mockResolvedValueOnce([]);
      mocks.workflow.addToQueue.mockResolvedValue([{ id: 'queue-1' }]);

      const result = await sut['backfill']({ workflowId });

      expect(result).toBe(JobStatus.Success);
      // The starting cursor has to be a real uuid, because `album_asset.updateId` is a uuid column and
      // comparing it against `''` fails with `invalid input syntax for type uuid: ""` on the first page
      // of every backfill. Asserted as a shape rather than a literal, so swapping the sentinel stays
      // free; asserting the literal is what let the original empty-string bug pass its own test.
      const [ownerIdArg, firstCursor] = mocks.workflow.getForAlbumAssetV1Backfill.mock.calls[0];
      expect(ownerIdArg).toBe(workflowRun.ownerId);
      expect(firstCursor).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
      // Regression: taking the first row's updateId here re-queues the rest of the batch every
      // iteration (N + (N-1) + ... + 1 for a batch of N). The batch's high-water mark is its LAST
      // row because `getForAlbumAssetV1Backfill` orders ascending by updateId.
      expect(mocks.workflow.getForAlbumAssetV1Backfill).toHaveBeenNthCalledWith(2, workflowRun.ownerId, 'cursor-b');
      expect(mocks.workflow.getForAlbumAssetV1Backfill).toHaveBeenCalledTimes(2);

      expect(mocks.workflow.addToQueue).toHaveBeenCalledTimes(1);
      expect(mocks.workflow.addToQueue).toHaveBeenCalledWith([
        {
          workflowId,
          data: [
            { asset: { id: 'asset-1' }, album: { id: 'album-1' } },
            { asset: { id: 'asset-2' }, album: { id: 'album-1' } },
          ],
        },
      ]);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.WorkflowRun, data: { queueId: 'queue-1' } }]);
    });

    it('should stop paging once a batch comes back empty', async () => {
      mocks.workflow.getForWorkflowRun.mockResolvedValue(workflowRun);
      mocks.workflow.getForAlbumAssetV1Backfill.mockResolvedValue([]);

      const result = await sut['backfill']({ workflowId });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.workflow.getForAlbumAssetV1Backfill).toHaveBeenCalledTimes(1);
      expect(mocks.workflow.addToQueue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });
});
