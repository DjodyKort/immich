import { AlbumController } from 'src/controllers/album.controller';
import { AlbumService } from 'src/services/album.service';
import request from 'supertest';
import { factory } from 'test/small.factory';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils';

describe(AlbumController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AlbumService);

  beforeAll(async () => {
    ctx = await controllerSetup(AlbumController, [{ provide: AlbumService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /albums', () => {
    it('should reject an invalid shared param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?isShared=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['isShared'], message: 'Invalid option: expected one of "true"|"false"' },
        ]),
      );
    });

    it('should reject an invalid assetId param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?assetId=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['assetId'], message: 'Invalid UUID' }]));
    });

    it('should accept hidden=true, since a query parameter arrives as a string', async () => {
      // Regression: `hidden` was declared as z.boolean(), which rejects the string "true" with
      // "expected boolean, received string". Nothing caught it - the medium tests call the service with
      // a real boolean and never cross the wire - so it only appeared when the endpoint was called for
      // real. Its siblings isOwned and isShared use stringToBool for exactly this reason.
      const { status } = await request(ctx.getHttpServer()).get('/albums?hidden=true');
      expect(status).not.toEqual(400);
    });

    it('should reject an invalid hidden param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?hidden=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['hidden'], message: 'Invalid option: expected one of "true"|"false"' },
        ]),
      );
    });
  });
});
