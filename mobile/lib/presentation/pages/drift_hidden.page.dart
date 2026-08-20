import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/bottom_sheet/hidden_bottom_sheet.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/widgets/common/mesmerizing_sliver_app_bar.dart';

/// Every asset withheld from at least one surface, gathered in one place regardless of which surfaces.
/// See `TimelineRepository.hidden` for why this is the one view a hidden asset can never fall out of.
@RoutePage()
class DriftHiddenPage extends StatelessWidget {
  const DriftHiddenPage({super.key});

  @override
  Widget build(BuildContext context) {
    return ProviderScope(
      overrides: [
        timelineServiceProvider.overrideWith((ref) {
          final user = ref.watch(currentUserProvider);
          if (user == null) {
            throw Exception('User must be logged in to access hidden assets');
          }

          final timelineService = ref.watch(timelineFactoryProvider).hidden(user.id);
          ref.onDispose(timelineService.dispose);
          return timelineService;
        }),
      ],
      child: Timeline(
        appBar: MesmerizingSliverAppBar(title: context.t.hidden, icon: Icons.visibility_off_outlined),
        bottomSheet: const HiddenBottomSheet(),
      ),
    );
  }
}
