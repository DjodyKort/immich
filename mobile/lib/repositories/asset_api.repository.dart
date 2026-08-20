import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/asset_edit.model.dart' hide AssetEditAction;
import 'package:immich_mobile/domain/models/stack.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/repositories/api.repository.dart';
import 'package:immich_mobile/utils/option.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import 'package:openapi/api.dart' as api show AssetSurface, AssetVisibility;
import 'package:openapi/api.dart' hide AssetSurface, AssetVisibility;

/// Every other field of `UpdateAssetDto` and `AssetBulkUpdateDto` defaults to absent; the surface arrays -
/// `hiddenFrom`, `hiddenFromAdd`, `hiddenFromRemove` - are generated with `Optional.present(const [])`
/// instead, so a request that simply omits `hiddenFrom` asks the server to *clear* the asset's exclusions.
/// Favouriting a photo from the phone would wipe what the web set. Every construction of those two DTOs
/// therefore has to say `absent` out loud for all three, and this names why. The two adjusting fields are
/// harmless at `[]` today - an empty add and an empty remove is a no-op the server short-circuits - but
/// they are spelled out anyway so no call site depends on that staying true.
/// The generator quirk is not ours to fix here: it is in the Dart client templates.
const _leaveHiddenFromAlone = Optional<List<api.AssetSurface>?>.absent();

final assetApiRepositoryProvider = Provider(
  (ref) => AssetApiRepository(
    ref.watch(apiServiceProvider).assetsApi,
    ref.watch(apiServiceProvider).stacksApi,
    ref.watch(apiServiceProvider).trashApi,
  ),
);

class AssetApiRepository extends ApiRepository {
  final AssetsApi _api;
  final StacksApi _stacksApi;
  final TrashApi _trashApi;

  AssetApiRepository(this._api, this._stacksApi, this._trashApi);

  Future<void> delete(List<String> ids, bool force) async {
    return _api.deleteAssets(AssetBulkDeleteDto(ids: ids, force: Optional.present(force)));
  }

  Future<void> restoreTrash(List<String> ids) async {
    await _trashApi.restoreAssets(BulkIdsDto(ids: ids));
  }

  Future<int> emptyTrash() async {
    final response = await _trashApi.emptyTrash();
    return response?.count ?? 0;
  }

  Future<int> restoreAllTrash() async {
    final response = await _trashApi.restoreTrash();
    return response?.count ?? 0;
  }

  // TODO(shenlong): remove after action migration
  Future<void> updateVisibility(List<String> ids, AssetVisibility visibility) async {
    return _api.updateAssets(
      AssetBulkUpdateDto(
        ids: ids,
        visibility: Optional.present(_mapVisibility(visibility)),
        hiddenFrom: _leaveHiddenFromAlone,
        hiddenFromAdd: _leaveHiddenFromAlone,
        hiddenFromRemove: _leaveHiddenFromAlone,
      ),
    );
  }

  Future<StackResponse> stack(List<String> ids) async {
    final responseDto = await checkNull(_stacksApi.createStack(StackCreateDto(assetIds: ids)));

    return responseDto.toStack();
  }

  Future<void> unStack(List<String> ids) async {
    return _stacksApi.deleteStacks(BulkIdsDto(ids: ids));
  }

  Future<Response> downloadAsset(String id, {required bool edited}) {
    return _api.downloadAssetWithHttpInfo(id, edited: edited);
  }

  api.AssetSurface _mapSurface(AssetSurface surface) => switch (surface) {
    AssetSurface.timeline => api.AssetSurface.timeline,
    AssetSurface.search => api.AssetSurface.search,
    AssetSurface.map => api.AssetSurface.map,
    AssetSurface.people => api.AssetSurface.people,
    AssetSurface.memories => api.AssetSurface.memories,
    AssetSurface.folders => api.AssetSurface.folders,
  };

  api.AssetVisibility _mapVisibility(AssetVisibility visibility) => switch (visibility) {
    AssetVisibility.timeline => api.AssetVisibility.timeline,
    AssetVisibility.hidden => api.AssetVisibility.hidden,
    AssetVisibility.locked => api.AssetVisibility.locked,
    AssetVisibility.archive => api.AssetVisibility.archive,
  };

  Future<String?> getAssetMIMEType(String assetId) async {
    final response = await checkNull(_api.getAssetInfo(assetId));

    // we need to get the MIME of the thumbnail once that gets added to the API
    return response.originalMimeType.orElse(null);
  }

  Future<void> updateDescription(String assetId, String description) {
    return _api.updateAsset(
      assetId,
      UpdateAssetDto(description: Optional.present(description), hiddenFrom: _leaveHiddenFromAlone),
    );
  }

  Future<void> updateRating(String assetId, int? rating) {
    return _api.updateAsset(
      assetId,
      UpdateAssetDto(rating: Optional.present(rating), hiddenFrom: _leaveHiddenFromAlone),
    );
  }

  Future<AssetEditsResponseDto?> editAsset(String assetId, List<AssetEdit> edits) {
    return _api.editAsset(assetId, AssetEditsCreateDto(edits: edits.map((e) => e.toApi()).toList()));
  }

  Future<void> removeEdits(String assetId) async {
    return _api.removeAssetEdits(assetId);
  }

  Future<void> update(
    List<String> remoteIds, {
    Option<bool> isFavorite = const .none(),
    Option<AssetVisibility> visibility = const .none(),
    Option<String> dateTimeOriginal = const .none(),
    Option<LatLng> location = const .none(),
  }) {
    return _api.updateAssets(
      AssetBulkUpdateDto(
        ids: remoteIds,
        isFavorite: isFavorite.toOptional(),
        visibility: visibility.map(_mapVisibility).toOptional(),
        dateTimeOriginal: dateTimeOriginal.toOptional(),
        latitude: location.map((loc) => loc.latitude).toOptional(),
        longitude: location.map((loc) => loc.longitude).toOptional(),
        hiddenFrom: _leaveHiddenFromAlone,
        hiddenFromAdd: _leaveHiddenFromAlone,
        hiddenFromRemove: _leaveHiddenFromAlone,
      ),
    );
  }

  /// Replaces the whole set of surfaces [assetId] is withheld from, and returns what the server stored.
  ///
  /// The single-asset route is deliberate. `PUT /assets` answers with nothing, while this answers with the
  /// asset, so the local row can be written from what the server actually stored rather than from what was
  /// asked for. An empty set is how "show it everywhere again" is expressed - the server treats `[]` and
  /// `null` alike.
  Future<Set<AssetSurface>> updateHiddenFrom(String assetId, Set<AssetSurface> surfaces) async {
    final response = await checkNull(
      _api.updateAsset(
        assetId,
        UpdateAssetDto(hiddenFrom: Optional.present(surfaces.map(_mapSurface).toList(growable: false))),
      ),
    );

    return response.hiddenFrom.map((surface) => surface.toAssetSurface()).toSet();
  }

  /// Switches [add] on and [remove] off for every asset in [ids], leaving their other exclusions alone.
  ///
  /// The bulk route rather than a loop over the single-asset one, and additive rather than replacing:
  /// the assets in a selection need not be withheld from the same places, so sending one complete
  /// `hiddenFrom` set would discard the difference. `hiddenFrom` is left absent here because naming it
  /// alongside these two is rejected by the server - it replaces, they adjust.
  Future<void> updateHiddenFromBulk(
    List<String> ids, {
    required Set<AssetSurface> add,
    required Set<AssetSurface> remove,
  }) {
    return _api.updateAssets(
      AssetBulkUpdateDto(
        ids: ids,
        hiddenFrom: _leaveHiddenFromAlone,
        hiddenFromAdd: Optional.present(add.map(_mapSurface).toList(growable: false)),
        hiddenFromRemove: Optional.present(remove.map(_mapSurface).toList(growable: false)),
      ),
    );
  }

  Future<void> updateLocation(List<String> ids, LatLng location) async {
    return _api.updateAssets(
      AssetBulkUpdateDto(
        ids: ids,
        latitude: Optional.present(location.latitude),
        longitude: Optional.present(location.longitude),
        hiddenFrom: _leaveHiddenFromAlone,
        hiddenFromAdd: _leaveHiddenFromAlone,
        hiddenFromRemove: _leaveHiddenFromAlone,
      ),
    );
  }

  Future<void> updateDateTime(List<String> ids, String dateTime) async {
    return _api.updateAssets(
      AssetBulkUpdateDto(
        ids: ids,
        dateTimeOriginal: Optional.present(dateTime),
        hiddenFrom: _leaveHiddenFromAlone,
        hiddenFromAdd: _leaveHiddenFromAlone,
        hiddenFromRemove: _leaveHiddenFromAlone,
      ),
    );
  }
}

extension on StackResponseDto {
  StackResponse toStack() {
    return StackResponse(id: id, primaryAssetId: primaryAssetId, assetIds: assets.map((asset) => asset.id).toList());
  }
}

extension on AssetEdit {
  AssetEditActionItemDto toApi() {
    return switch (this) {
      CropEdit(:final parameters) => AssetEditActionItemDto(
        action: AssetEditAction.crop,
        parameters: parameters.toJson(),
      ),
      RotateEdit(:final parameters) => AssetEditActionItemDto(
        action: AssetEditAction.rotate,
        parameters: parameters.toJson(),
      ),
      MirrorEdit(:final parameters) => AssetEditActionItemDto(
        action: AssetEditAction.mirror,
        parameters: parameters.toJson(),
      ),
    };
  }
}

/// The wire vocabulary for per-surface hiding, translated into mobile's own.
///
/// Exhaustive by construction: a surface added on the server fails to compile here rather than being
/// silently dropped, which for a *hiding* rule would mean showing what should be hidden.
extension on api.AssetSurface {
  AssetSurface toAssetSurface() => switch (this) {
    api.AssetSurface.timeline => AssetSurface.timeline,
    api.AssetSurface.search => AssetSurface.search,
    api.AssetSurface.map => AssetSurface.map,
    api.AssetSurface.people => AssetSurface.people,
    api.AssetSurface.memories => AssetSurface.memories,
    api.AssetSurface.folders => AssetSurface.folders,
  };
}
