import { WorkflowTrigger } from '@immich/plugin-sdk';
import { BadRequestException } from '@nestjs/common';
import { JobName } from 'src/enum';
import { WorkflowService } from 'src/services/workflow.service';
import { AuthFactory } from 'test/factories/auth.factory';
import { newTestService, ServiceMocks } from 'test/utils';

describe(WorkflowService.name, () => {
  let sut: WorkflowService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(WorkflowService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('backfill', () => {
    const auth = AuthFactory.create();
    const workflow = {
      id: 'workflow-1',
      name: 'test workflow',
      description: null,
      trigger: WorkflowTrigger.AlbumAssetAdded,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ownerId: auth.user.id,
      logging: false,
      steps: [],
    };

    beforeEach(() => {
      mocks.access.workflow.checkOwnerAccess.mockResolvedValue(new Set([workflow.id]));
    });

    it('should reject a workflow whose trigger is not album-asset-added', async () => {
      mocks.workflow.get.mockResolvedValue({ ...workflow, trigger: WorkflowTrigger.AssetCreate });

      await expect(sut.backfill(auth, workflow.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.backfill(auth, workflow.id)).rejects.toThrow(/AssetCreate/);

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should reject a disabled workflow', async () => {
      mocks.workflow.get.mockResolvedValue({ ...workflow, enabled: false });

      await expect(sut.backfill(auth, workflow.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should queue exactly one backfill job for an enabled album-asset-added workflow', async () => {
      mocks.workflow.get.mockResolvedValue(workflow);

      await sut.backfill(auth, workflow.id);

      expect(mocks.job.queue).toHaveBeenCalledTimes(1);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.WorkflowBackfill,
        data: { workflowId: workflow.id },
      });
    });
  });
});
