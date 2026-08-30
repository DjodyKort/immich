import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import {
  AddUsersDto,
  AlbumLockImpactDto,
  AlbumLockImpactResponseDto,
  AlbumResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  AlbumSetHiddenFromDto,
  AlbumSetLockedDto,
  AlbumSetParentDto,
  AlbumStatisticsResponseDto,
  AlbumUserParamDto,
  CreateAlbumDto,
  GetAlbumsDto,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
} from 'src/dtos/album.dto';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { MapMarkerResponseDto } from 'src/dtos/map.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { AlbumService } from 'src/services/album.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.Albums)
@Controller('albums')
export class AlbumController {
  constructor(private service: AlbumService) {}

  @Get()
  @Authenticated({ permission: Permission.AlbumRead })
  @Endpoint({
    summary: 'List all albums',
    description: 'Retrieve a list of albums available to the authenticated user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAllAlbums(@Auth() auth: AuthDto, @Query() query: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    return this.service.getAll(auth, query);
  }

  @Post()
  @Authenticated({ permission: Permission.AlbumCreate })
  @Endpoint({
    summary: 'Create an album',
    description: 'Create a new album. The album can also be created with initial users and assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createAlbum(@Auth() auth: AuthDto, @Body() dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get('statistics')
  @Authenticated({ permission: Permission.AlbumStatistics })
  @Endpoint({
    summary: 'Retrieve album statistics',
    description: 'Returns statistics about the albums available to the authenticated user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAlbumStatistics(@Auth() auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    return this.service.getStatistics(auth);
  }

  @Authenticated({ permission: Permission.AlbumRead, sharedLink: true })
  @Get(':id')
  @Endpoint({
    summary: 'Retrieve an album',
    description: 'Retrieve information about a specific album by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAlbumInfo(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AlbumResponseDto> {
    return this.service.get(auth, id);
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Update an album',
    description:
      'Update the information of a specific album by its ID. This endpoint can be used to update the album name, description, sort order, etc. However, it is not used to add or remove assets or users from the album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  updateAlbumInfo(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: UpdateAlbumDto,
  ): Promise<AlbumResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Put(':id/locked')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Lock or unlock an album',
    description:
      'Move an album, and every asset in it, into or out of the locked folder. Requires an elevated session and an album you own that is not shared and whose every asset you own. Locking sets those assets to Locked visibility and removes them from all other albums; unlocking returns them to the timeline and leaves them in this album. Separate from the update endpoint because it rewrites the assets, not just the album.',
    history: new HistoryBuilder().added('v3'),
  })
  setAlbumLocked(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumSetLockedDto,
  ): Promise<AlbumResponseDto> {
    return this.service.setLocked(auth, id, dto);
  }

  @Put(':id/hidden-from')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: "Set where an album's photos appear",
    description:
      "Withhold this album's photos from chosen surfaces. Owner only. Members inherit the rule on joining and stop inheriting it on leaving; rules from several albums combine, so a photo hidden by any of its albums is hidden, and a photo can opt back out individually. Distinct from `isHidden` on the update endpoint, which hides the album itself and touches no photo. Separate from that endpoint because it rewrites derived state on every member.",
    history: new HistoryBuilder().added('v3'),
  })
  setAlbumHiddenFrom(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumSetHiddenFromDto,
  ): Promise<AlbumResponseDto> {
    return this.service.setHiddenFrom(auth, id, dto);
  }

  @Get(':id/lock-impact')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Preview what locking this album would do',
    description:
      'Read-only. Reports the albums that would be locked, how many photos would move into the locked folder, and which *other* albums would lose photos -- because a locked asset may not remain in an ordinary album. Pass includeSubAlbums to preview the whole branch. A refusal comes back as `blockedReason` rather than an error, since the caller asked what would happen. Its own endpoint rather than a dry-run flag on the lock route, so asking can never be mistaken for doing.',
    history: new HistoryBuilder().added('v3'),
  })
  getAlbumLockImpact(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() { includeSubAlbums }: AlbumLockImpactDto,
  ): Promise<AlbumLockImpactResponseDto> {
    return this.service.getLockImpact(auth, id, includeSubAlbums ?? false);
  }

  @Put(':id/parent')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Move an album into another album',
    description:
      'Set which album this one sits inside, or pass null to move it to the top level. Owner only, and both albums must be yours. Refused if the target is this album or one of its own sub-albums, or if the resulting tree would be too deep. Locked albums may only be nested under locked albums and vice versa -- a normal album may still contain locked children, so moving a locked album to the top level is always allowed. Separate from the update endpoint because it is validated against the rest of the hierarchy rather than being a property assignment.',
    history: new HistoryBuilder().added('v3'),
  })
  setAlbumParent(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AlbumSetParentDto,
  ): Promise<AlbumResponseDto> {
    return this.service.setParent(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.AlbumDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete an album',
    description:
      'Delete a specific album by its ID. Note the album is initially trashed and then immediately scheduled for deletion, but relies on a background job to complete the process.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deleteAlbum(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.service.delete(auth, id);
  }

  @Authenticated({ permission: Permission.AlbumRead, sharedLink: true })
  @Get(':id/map-markers')
  @Endpoint({
    summary: 'Retrieve album map markers',
    description: 'Retrieve map marker information for a specific album by its ID.',
    history: new HistoryBuilder().added('v3'),
  })
  getAlbumMapMarkers(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<MapMarkerResponseDto[]> {
    return this.service.getMapMarkers(auth, id);
  }

  @Put(':id/assets')
  @Authenticated({ permission: Permission.AlbumAssetCreate })
  @Endpoint({
    summary: 'Add assets to an album',
    description: 'Add multiple assets to a specific album by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  addAssetsToAlbum(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BulkIdsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.addAssets(auth, id, dto);
  }

  @Put(':id/locked-assets')
  @Authenticated({ permission: Permission.AlbumAssetCreate })
  @Endpoint({
    summary: 'Move assets into a locked album',
    description:
      'Lock the given assets and add them to a locked album, as one operation. Requires an elevated session, an album you own that is already locked, and assets you own. The assets are set to Locked visibility and removed from every other album. Distinct from the ordinary add-assets endpoint, which locks nothing and would be refused for a locked album; doing both as two calls can half-apply and leave assets locked but in no album.',
    history: new HistoryBuilder().added('v3'),
  })
  addLockedAssetsToAlbum(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: BulkIdsDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.addLockedAssets(auth, id, dto);
  }

  @Put('assets')
  @Authenticated({ permission: Permission.AlbumAssetCreate })
  @Endpoint({
    summary: 'Add assets to albums',
    description: 'Send a list of asset IDs and album IDs to add each asset to each album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  addAssetsToAlbums(@Auth() auth: AuthDto, @Body() dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    return this.service.addAssetsToAlbums(auth, dto);
  }

  @Delete(':id/assets')
  @Authenticated({ permission: Permission.AlbumAssetDelete })
  @Endpoint({
    summary: 'Remove assets from an album',
    description: 'Remove multiple assets from a specific album by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  removeAssetFromAlbum(
    @Auth() auth: AuthDto,
    @Body() dto: BulkIdsDto,
    @Param() { id }: UUIDParamDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.removeAssets(auth, id, dto);
  }

  @Put(':id/users')
  @Authenticated({ permission: Permission.AlbumUserCreate })
  @Endpoint({
    summary: 'Share album with users',
    description: 'Share an album with multiple users. Each user can be given a specific role in the album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  addUsersToAlbum(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AddUsersDto,
  ): Promise<AlbumResponseDto> {
    return this.service.addUsers(auth, id, dto);
  }

  @Put(':id/user/:userId')
  @Authenticated({ permission: Permission.AlbumUserUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Update user role',
    description: 'Change the role for a specific user in a specific album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  updateAlbumUser(
    @Auth() auth: AuthDto,
    @Param() { id, userId }: AlbumUserParamDto,
    @Body() dto: UpdateAlbumUserDto,
  ): Promise<void> {
    return this.service.updateUser(auth, id, userId, dto);
  }

  @Delete(':id/user/:userId')
  @Authenticated({ permission: Permission.AlbumUserDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove user from album',
    description: 'Remove a user from an album. Use an ID of "me" to leave a shared album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  removeUserFromAlbum(@Auth() auth: AuthDto, @Param() { id, userId }: AlbumUserParamDto): Promise<void> {
    return this.service.removeUser(auth, id, userId);
  }
}
