import 'dart:io';
import 'dart:isolate';

import 'package:archive/archive_io.dart';
import 'package:jhentai/src/service/log.dart';
import 'package:jhentai/src/utils/file_util.dart';
import 'package:path/path.dart' as p;

/// Turns a downloaded gallery directory into a `.cbz` archive.
///
/// Packing runs in a separate isolate because a gallery can contain hundreds
/// of images. Images are already compressed, so entries are stored without
/// deflate ([ZipFileEncoder.STORE]).
class CbzService {
  CbzService._();

  static final CbzService instance = CbzService._();

  /// Galleries requested through the web UI with the "pack as CBZ" option.
  /// Kept in memory only: after a restart the persisted download setting is
  /// the source of truth.
  final Set<int> _pendingGalleryCbz = <int>{};

  static String cbzPathForDirectory(String sourceDir) => '$sourceDir.cbz';

  void markGalleryForCbz(int gid) => _pendingGalleryCbz.add(gid);

  bool consumeGalleryCbzRequest(int gid) => _pendingGalleryCbz.remove(gid);

  /// Packs [sourceDir] into [outputPath] (defaults to `<sourceDir>.cbz`).
  ///
  /// The archive is written to a temporary `.part` file first so a interrupted
  /// pack never leaves a broken `.cbz` behind.
  Future<File> packDirectory({
    required String sourceDir,
    String? outputPath,
    bool deleteSource = false,
    bool overwrite = true,
  }) async {
    final Directory source = Directory(sourceDir);
    if (!await source.exists()) {
      throw FileSystemException('Gallery directory does not exist', sourceDir);
    }

    final String output = outputPath ?? cbzPathForDirectory(sourceDir);

    if (!overwrite && await File(output).exists()) {
      return File(output);
    }

    final String tempPath = '$output.part';
    final File tempFile = File(tempPath);
    if (await tempFile.exists()) {
      await tempFile.delete();
    }
    await Directory(p.dirname(output)).create(recursive: true);

    try {
      await Isolate.run(() => _packDirectoryInIsolate(sourceDir, tempPath));

      final File outputFile = File(output);
      if (await outputFile.exists()) {
        await outputFile.delete();
      }
      await File(tempPath).rename(output);

      if (deleteSource) {
        try {
          await source.delete(recursive: true);
        } catch (e, stack) {
          log.error('Failed to delete gallery directory after packing: $sourceDir', e, stack);
        }
      }

      log.download('Packed CBZ: $output');
      return outputFile;
    } catch (e, stack) {
      if (await tempFile.exists()) {
        await tempFile.delete();
      }
      log.error('Pack CBZ failed: $sourceDir', e, stack);
      rethrow;
    }
  }
}

Future<void> _packDirectoryInIsolate(String sourceDir, String outputPath) async {
  final Directory source = Directory(sourceDir);
  final List<File> files = source
      .listSync(recursive: true, followLinks: false)
      .whereType<File>()
      .where((File file) => !file.path.endsWith('.part'))
      .toList()
    ..sort(FileUtil.naturalCompareFile);

  if (files.isEmpty) {
    throw const FileSystemException('Gallery directory contains no files');
  }

  final ZipFileEncoder encoder = ZipFileEncoder();
  encoder.create(outputPath, level: ZipFileEncoder.STORE);
  try {
    for (final File file in files) {
      final String name = p.relative(file.path, from: source.path).replaceAll('\\', '/');
      await encoder.addFile(file, name, ZipFileEncoder.STORE);
    }
  } finally {
    await encoder.close();
  }
}
