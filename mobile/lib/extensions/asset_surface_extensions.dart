import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:openapi/api.dart' as api;

/// The wire vocabulary for per-surface hiding, translated to and from mobile's own.
///
/// Extracted once a fourth caller needed it. The same `toAssetSurface` switch existed privately in
/// `asset_extensions.dart`, `sync_stream.repository.dart` and `asset_api.repository.dart`; three copies of
/// an exhaustive switch is three places to forget when a surface is added, and forgetting one on a
/// *hiding* rule means showing what should be hidden.
///
/// Both directions are exhaustive by construction, so a surface added on the server fails to compile here
/// rather than being silently dropped.
extension ApiAssetSurfaceEx on api.AssetSurface {
  AssetSurface toAssetSurface() => switch (this) {
    api.AssetSurface.timeline => AssetSurface.timeline,
    api.AssetSurface.search => AssetSurface.search,
    api.AssetSurface.map => AssetSurface.map,
    api.AssetSurface.people => AssetSurface.people,
    api.AssetSurface.memories => AssetSurface.memories,
    api.AssetSurface.folders => AssetSurface.folders,
  };
}

extension AssetSurfaceApiEx on AssetSurface {
  api.AssetSurface toDto() => switch (this) {
    AssetSurface.timeline => api.AssetSurface.timeline,
    AssetSurface.search => api.AssetSurface.search,
    AssetSurface.map => api.AssetSurface.map,
    AssetSurface.people => api.AssetSurface.people,
    AssetSurface.memories => api.AssetSurface.memories,
    AssetSurface.folders => api.AssetSurface.folders,
  };
}
