import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart' show Color, ThemeMode;
import 'package:flutter/services.dart' show rootBundle;
import 'package:get/get.dart';
import 'package:jhentai/src/database/database.dart';
import 'package:jhentai/src/model/gallery.dart';
import 'package:jhentai/src/model/gallery_archive.dart';
import 'package:jhentai/src/model/gallery_comment.dart';
import 'package:jhentai/src/model/gallery_detail.dart';
import 'package:jhentai/src/model/gallery_hh_info.dart';
import 'package:jhentai/src/model/gallery_image.dart';
import 'package:jhentai/src/model/gallery_page.dart';
import 'package:jhentai/src/model/gallery_stats.dart';
import 'package:jhentai/src/model/gallery_tag.dart';
import 'package:jhentai/src/model/gallery_torrent.dart';
import 'package:jhentai/src/model/gallery_url.dart';
import 'package:jhentai/src/model/search_config.dart';
import 'package:jhentai/src/network/eh_request.dart';
import 'package:jhentai/src/pages/ranklist/ranklist_page_state.dart';
import 'package:jhentai/src/service/archive_download_service.dart';
import 'package:jhentai/src/service/gallery_download/download_path_resolver.dart';
import 'package:jhentai/src/service/gallery_download/gallery_download_service.dart';
import 'package:jhentai/src/service/history_service.dart';
import 'package:jhentai/src/service/jh_service.dart';
import 'package:jhentai/src/service/local_gallery_service.dart';
import 'package:jhentai/src/service/log.dart';
import 'package:jhentai/src/service/path_service.dart';
import 'package:jhentai/src/service/read_progress_service.dart';
import 'package:jhentai/src/service/web_server/cbz_service.dart';
import 'package:jhentai/src/setting/download_setting.dart';
import 'package:jhentai/src/setting/eh_setting.dart';
import 'package:jhentai/src/setting/favorite_setting.dart';
import 'package:jhentai/src/setting/network_setting.dart';
import 'package:jhentai/src/setting/preference_setting.dart';
import 'package:jhentai/src/setting/style_setting.dart';
import 'package:jhentai/src/setting/user_setting.dart';
import 'package:jhentai/src/setting/web_server_setting.dart';
import 'package:jhentai/src/utils/convert_util.dart';
import 'package:jhentai/src/utils/eh_spider_parser.dart';
import 'package:jhentai/src/utils/file_util.dart';
import 'package:jhentai/src/utils/locale_util.dart';
import 'package:path/path.dart' as p;

WebServerService webServerService = WebServerService();

/// A small HTTP server that exposes JHenTai to a browser.
///
/// It intentionally reuses [ehRequest], so the browser inherits the app's
/// cookies, proxy and domain-fronting configuration instead of needing a
/// second login. All state lives in the running app.
class WebServerService extends GetxController with JHLifeCircleBeanErrorCatch implements JHLifeCircleBean {
  static const String _uiAssetRoot = 'assets/webui';

  HttpServer? _server;
  StreamSubscription<HttpRequest>? _subscription;

  final RxBool running = false.obs;
  final RxString displayAddress = 'http://127.0.0.1:${WebServerSetting.defaultPort}'.obs;
  final Map<String, Uint8List> _assetCache = {};

  static const int _proxyConcurrency = 4;
  static const int _proxyCacheMaxBytes = 32 * 1024 * 1024;
  int _proxyActive = 0;
  final List<Completer<void>> _proxyQueue = [];
  final Map<String, ({Uint8List bytes, String contentType})> _proxyCache = {};
  int _proxyCacheBytes = 0;

  static const List<String> _proxyHostSuffixes = [
    'e-hentai.org',
    'exhentai.org',
    'ehgt.org',
    'hath.network',
    'hentaiviewer.net',
    'ehwiki.org',
  ];

  @override
  List<JHLifeCircleBean> get initDependencies => super.initDependencies..addAll([downloadSetting, webServerSetting]);

  @override
  Future<void> doInitBean() async {
    Get.put(this, permanent: true);
  }

  @override
  Future<void> doAfterBeanReady() async {
    if (webServerSetting.enable.isTrue) {
      await start();
    }
  }

  @override
  void onClose() {
    unawaited(stop());
    super.onClose();
  }

  String get address => displayAddress.value;

  Future<String> _computeDisplayAddress() async {
    final int port = webServerSetting.port.value;
    if (webServerSetting.allowRemote.isFalse) {
      return 'http://127.0.0.1:$port';
    }

    try {
      final List<NetworkInterface> interfaces = await NetworkInterface.list(
        type: InternetAddressType.IPv4,
        includeLinkLocal: false,
      );
      for (final NetworkInterface interface in interfaces) {
        for (final InternetAddress address in interface.addresses) {
          if (!address.isLoopback) {
            return 'http://${address.address}:$port';
          }
        }
      }
    } catch (e) {
      log.debug('Failed to detect LAN address: $e');
    }

    return 'http://127.0.0.1:$port';
  }

  Future<void> start() async {
    if (_server != null) {
      return;
    }

    final InternetAddress bindAddress = webServerSetting.allowRemote.isTrue ? InternetAddress.anyIPv4 : InternetAddress.loopbackIPv4;

    try {
      final HttpServer server = await HttpServer.bind(bindAddress, webServerSetting.port.value, shared: false);
      server.autoCompress = true;
      _server = server;
      running.value = true;
      displayAddress.value = await _computeDisplayAddress();
      _subscription = server.listen(
        (HttpRequest request) => unawaited(_handleRequest(request)),
        onError: (Object error, StackTrace stack) => log.error('Web server error', error, stack),
      );
      log.info('Web server started at http://${bindAddress.address}:${webServerSetting.port.value}');
    } catch (e, stack) {
      running.value = false;
      log.error('Failed to start web server on port ${webServerSetting.port.value}', e, stack);
      rethrow;
    }
  }

  Future<void> stop() async {
    final StreamSubscription<HttpRequest>? subscription = _subscription;
    final HttpServer? server = _server;
    _subscription = null;
    _server = null;
    running.value = false;

    await subscription?.cancel();
    await server?.close(force: true);

    if (server != null) {
      log.info('Web server stopped');
    }
  }

  Future<void> restart() async {
    await stop();
    if (webServerSetting.enable.isTrue) {
      await start();
    }
  }

  Future<void> _handleRequest(HttpRequest request) async {
    _applyCors(request);

    if (request.method == 'OPTIONS') {
      request.response.statusCode = HttpStatus.noContent;
      await request.response.close();
      return;
    }

    try {
      if (!request.uri.path.startsWith('/api/')) {
        await _serveStatic(request);
        return;
      }

      if (!_isAuthorized(request)) {
        await _sendJson(request, HttpStatus.unauthorized, {'error': 'unauthorized'});
        return;
      }

      await _routeApi(request);
    } catch (e, stack) {
      log.error('Web server request failed: ${request.method} ${request.uri}', e, stack);
      try {
        await _sendJson(request, HttpStatus.internalServerError, {'error': e.toString()});
      } catch (_) {
        try {
          await request.response.close();
        } catch (_) {}
      }
    }
  }

  void _applyCors(HttpRequest request) {
    request.response.headers.set('Access-Control-Allow-Origin', '*');
    request.response.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    request.response.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token, Authorization');
    request.response.headers.set('Cache-Control', 'no-store');
  }

  bool _isAuthorized(HttpRequest request) {
    final String expected = webServerSetting.token.value.trim();
    if (expected.isEmpty) {
      return true;
    }

    final String? headerToken = request.headers.value('x-auth-token');
    if (headerToken == expected) {
      return true;
    }

    final String? authorization = request.headers.value(HttpHeaders.authorizationHeader);
    if (authorization != null && authorization.replaceFirst('Bearer ', '') == expected) {
      return true;
    }

    final String? queryToken = request.uri.queryParameters['token'];
    if (queryToken == expected) {
      return true;
    }

    for (final Cookie cookie in request.cookies) {
      if (cookie.name == 'jh_web_token' && cookie.value == expected) {
        return true;
      }
    }

    return false;
  }

  Future<void> _routeApi(HttpRequest request) async {
    final List<String> segments = request.uri.pathSegments;
    final String method = request.method;

    if (segments.length == 2) {
      switch (segments[1]) {
        case 'status':
          return _sendJson(request, HttpStatus.ok, {
            'loggedIn': userSetting.hasLoggedIn(),
            'downloadAsCbz': downloadSetting.downloadAsCbz.value,
            'taskCount': galleryDownloadService.galleryDownloadInfos.length,
          });
        case 'search':
          return _handleSearch(request);
        case 'galleries':
          return _handleGalleries(request);
        case 'ranklist':
          return _handleRanklist(request);
        case 'history':
          return _handleHistory(request);
        case 'gallery':
          return _handleGalleryDetail(request);
        case 'read':
          return _sendJson(request, HttpStatus.notFound, {'error': 'not found'});
        case 'download':
          if (method != 'POST') {
            return _sendJson(request, HttpStatus.methodNotAllowed, {'error': 'method not allowed'});
          }
          return _handleCreateDownload(request);
        case 'tasks':
          return _handleTasks(request);
        case 'library':
          return _handleLibrary(request);
        case 'proxy':
          return _handleProxy(request);
        case 'settings':
          return _handleSettings(request);
        case 'appearance':
          return _handleAppearance(request);
        case 'network':
          return _handleNetwork(request);
        case 'favorite':
          if (method != 'POST') {
            return _sendJson(request, HttpStatus.methodNotAllowed, {'error': 'method not allowed'});
          }
          return _handleFavoriteAction(request);
        case 'rating':
          if (method != 'POST') {
            return _sendJson(request, HttpStatus.methodNotAllowed, {'error': 'method not allowed'});
          }
          return _handleRating(request);
        case 'comment':
          if (method != 'POST') {
            return _sendJson(request, HttpStatus.methodNotAllowed, {'error': 'method not allowed'});
          }
          return _handleComment(request);
        case 'torrents':
          return _handleTorrents(request);
        case 'stats':
          return _handleStats(request);
        case 'archive':
          return _handleArchive(request);
        case 'hh':
          return _handleHH(request);
        case 'filters':
          return _handleFilters(request);
        case 'archive-tasks':
          return _handleArchiveTasks(request);
        case 'local-galleries':
          return _handleLocalGalleries(request);
        case 'progress':
          return _handleProgress(request);
      }
    }

    if (segments.length >= 3 && segments[1] == 'read') {
      if (segments[2] == 'pages') {
        return _handleReadPages(request);
      }
      if (segments[2] == 'image') {
        return _handleReadImage(request);
      }
      return _sendJson(request, HttpStatus.notFound, {'error': 'not found'});
    }

    if (segments.length >= 3 && segments[1] == 'archive') {
      if (segments[2] == 'download') {
        if (method != 'POST') {
          return _sendJson(request, HttpStatus.methodNotAllowed, {'error': 'method not allowed'});
        }
        return _handleArchiveDownload(request);
      }
      return _sendJson(request, HttpStatus.notFound, {'error': 'not found'});
    }

    if (segments.length >= 3 && segments[1] == 'archive-tasks') {
      final int? gid = int.tryParse(segments[2]);
      if (gid == null) {
        return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gid'});
      }
      if (segments.length == 4) {
        return _handleArchiveTaskAction(request, gid, segments[3]);
      }
      return _sendJson(request, HttpStatus.notFound, {'error': 'not found'});
    }

    if (segments.length >= 3 && segments[1] == 'archive-library') {
      final int? gid = int.tryParse(segments[2]);
      if (gid == null) {
        return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gid'});
      }
      if (segments.length == 3) {
        return _handleArchiveLibraryDetail(request, gid);
      }
      if (segments.length == 4 && segments[3] == 'images') {
        return _handleArchiveLibraryDetail(request, gid);
      }
      if (segments.length == 4 && segments[3] == 'cover') {
        return _serveArchiveLibraryImage(request, gid, 0);
      }
      if (segments.length == 5 && segments[3] == 'file') {
        final int? serialNo = int.tryParse(segments[4]);
        if (serialNo == null) {
          return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid serial'});
        }
        return _serveArchiveLibraryImage(request, gid, serialNo);
      }
      return _sendJson(request, HttpStatus.notFound, {'error': 'not found'});
    }

    if (segments.length >= 3 && segments[1] == 'local-galleries') {
      if (segments[2] == 'images') {
        return _handleLocalGalleryImages(request);
      }
      if (segments[2] == 'file') {
        final int? index = int.tryParse(request.uri.queryParameters['index'] ?? '');
        if (index == null) {
          return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid index'});
        }
        return _serveLocalGalleryImage(request, index);
      }
      if (segments[2] == 'cover') {
        return _serveLocalGalleryImage(request, 0);
      }
      return _sendJson(request, HttpStatus.notFound, {'error': 'not found'});
    }

    if (segments.length >= 3 && segments[1] == 'history') {
      if (segments[2] == 'all') {
        if (method != 'DELETE') {
          return _sendJson(request, HttpStatus.methodNotAllowed, {'error': 'method not allowed'});
        }
        await historyService.deleteAll();
        return _sendJson(request, HttpStatus.ok, {'ok': true});
      }
      if (method == 'DELETE') {
        final int? gid = int.tryParse(segments[2]);
        if (gid != null) {
          await historyService.delete(gid);
          return _sendJson(request, HttpStatus.ok, {'ok': true});
        }
      }
      return _sendJson(request, HttpStatus.notFound, {'error': 'not found'});
    }

    if (segments.length >= 3 && segments[1] == 'tasks') {
      final int? gid = int.tryParse(segments[2]);
      if (gid == null) {
        return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gid'});
      }
      if (segments.length == 4) {
        return _handleTaskAction(request, gid, segments[3]);
      }
      return _sendJson(request, HttpStatus.notFound, {'error': 'not found'});
    }

    if (segments.length >= 3 && segments[1] == 'library') {
      final int? gid = int.tryParse(segments[2]);
      if (gid == null) {
        return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gid'});
      }
      if (segments.length == 3) {
        return _handleLibraryDetail(request, gid);
      }
      if (segments.length == 4 && segments[3] == 'cover') {
        return _serveCover(request, gid);
      }
      if (segments.length == 4 && segments[3] == 'images') {
        return _handleLibraryImages(request, gid);
      }
      if (segments.length == 4 && segments[3] == 'cbz') {
        return _serveCbz(request, gid);
      }
      if (segments.length == 5 && segments[3] == 'file') {
        final int? serialNo = int.tryParse(segments[4]);
        if (serialNo == null) {
          return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid serial number'});
        }
        return _serveLibraryImage(request, gid, serialNo);
      }
    }

    await _sendJson(request, HttpStatus.notFound, {'error': 'not found'});
  }

  Future<void> _serveStatic(HttpRequest request) async {
    String path = request.uri.path;
    if (path == '/' || path.isEmpty) {
      path = '/index.html';
    }

    String assetName = path.substring(1);
    if (assetName.contains('..') || assetName.contains('/')) {
      assetName = 'index.html';
    }

    Uint8List? bytes = _assetCache[assetName];
    if (bytes == null) {
      try {
        bytes = await _loadAsset(assetName);
        _assetCache[assetName] = bytes;
      } catch (_) {
        bytes = _assetCache['index.html'] ?? await _loadAsset('index.html');
        _assetCache['index.html'] = bytes;
      }
    }

    request.response.headers.contentType = _contentTypeFor(assetName);
    request.response.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
    request.response.contentLength = bytes.length;
    request.response.add(bytes);
    await request.response.close();
  }

  Future<Uint8List> _loadAsset(String name) async {
    /// Desktop builds keep assets next to the executable, so an updated Web UI
    /// can be served without rebuilding the Flutter app. Android/iOS fall back
    /// to the bundled asset.
    try {
      final String assetDir = p.join(p.dirname(Platform.resolvedExecutable), 'data', 'flutter_assets', _uiAssetRoot, name);
      final File file = File(assetDir);
      if (await file.exists()) {
        return await file.readAsBytes();
      }
    } catch (_) {}

    final ByteData data = await rootBundle.load('$_uiAssetRoot/$name');
    return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  }

  ContentType _contentTypeFor(String name) {
    switch (p.extension(name).toLowerCase()) {
      case '.html':
        return ContentType.html;
      case '.js':
        return ContentType('application', 'javascript', charset: 'utf-8');
      case '.css':
        return ContentType('text', 'css', charset: 'utf-8');
      case '.json':
        return ContentType.json;
      case '.svg':
        return ContentType('image', 'svg+xml');
      case '.png':
        return ContentType('image', 'png');
      case '.jpg':
      case '.jpeg':
        return ContentType('image', 'jpeg');
      case '.gif':
        return ContentType('image', 'gif');
      case '.webp':
        return ContentType('image', 'webp');
      case '.bmp':
        return ContentType('image', 'bmp');
      case '.avif':
        return ContentType('image', 'avif');
      case '.ico':
        return ContentType('image', 'x-icon');
      case '.cbz':
        return ContentType('application', 'x-cbz');
      case '.otf':
        return ContentType('font', 'otf');
      case '.ttf':
        return ContentType('font', 'ttf');
      case '.woff2':
        return ContentType('font', 'woff2');
      default:
        return ContentType.text;
    }
  }

  Future<T> _retryRequest<T>(Future<T> Function() task, {int attempts = 2}) async {
    Object? lastError;
    StackTrace? lastStack;
    for (int attempt = 0; attempt < attempts; attempt++) {
      try {
        return await ehRequest.runWithConnectTimeout(const Duration(seconds: 15), task);
      } catch (e, stack) {
        lastError = e;
        lastStack = stack;
        if (attempt < attempts - 1) {
          await Future<void>.delayed(Duration(milliseconds: 400 * (attempt + 1)));
        }
      }
    }
    Error.throwWithStackTrace(lastError!, lastStack!);
  }

  Future<void> _handleSearch(HttpRequest request) async {
    return _handleGalleries(request, forceType: 'search');
  }

  Future<void> _handleGalleries(HttpRequest request, {String? forceType}) async {
    final Map<String, String> params = request.uri.queryParameters;
    final String type = forceType ?? params['type'] ?? 'home';

    if ((type == 'favorite' || type == 'watched') && !userSetting.hasLoggedIn()) {
      return _sendJson(request, HttpStatus.forbidden, {'error': 'login required'});
    }

    final SearchConfig searchConfig = _searchConfigFromQuery(request, type);

    final GalleryPageInfo page = await _retryRequest(() => ehRequest.requestGalleryPage(
      searchConfig: searchConfig,
      nextGid: params['next'],
      seek: DateTime.tryParse(params['seek'] ?? ''),
      parser: EHSpiderParser.galleryPage2GalleryPageInfo,
    ));

    await _sendJson(request, HttpStatus.ok, {
      'galleries': page.galleries.map(_galleryToJson).toList(),
      'nextGid': page.nextGid,
      'prevGid': page.prevGid,
      'totalCount': page.totalCount?.count,
      'favoriteSortOrder': page.favoriteSortOrder?.name,
    });
  }

  SearchConfig _searchConfigFromQuery(HttpRequest request, String type) {
    final Map<String, String> p = request.uri.queryParameters;
    final Set<String> cats = (p['cats'] ?? '')
        .split(',')
        .map((String e) => e.trim().toLowerCase())
        .where((String e) => e.isNotEmpty)
        .toSet();
    bool include(String name) => cats.isEmpty || cats.contains(name);

    final String keyword = (p['q'] ?? '').trim();

    SearchType searchType;
    switch (type) {
      case 'popular':
        searchType = SearchType.popular;
        break;
      case 'favorite':
        searchType = SearchType.favorite;
        break;
      case 'watched':
        searchType = SearchType.watched;
        break;
      default:
        searchType = SearchType.gallery;
    }

    return SearchConfig(
      searchType: searchType,
      keyword: keyword.isEmpty ? null : keyword,
      includeDoujinshi: include('doujinshi'),
      includeManga: include('manga'),
      includeArtistCG: include('artistcg'),
      includeGameCg: include('gamecg'),
      includeWestern: include('western'),
      includeNonH: include('nonh'),
      includeImageSet: include('imageset'),
      includeCosplay: include('cosplay'),
      includeAsianPorn: include('asianporn'),
      includeMisc: include('misc'),
      language: (p['language'] ?? '').trim().isEmpty ? null : p['language']!.trim(),
      minimumRating: int.tryParse(p['minRating'] ?? '') ?? 1,
      onlySearchExpungedGalleries: p['expunged'] == '1',
      onlyShowGalleriesWithTorrents: p['torrents'] == '1',
      pageAtLeast: int.tryParse(p['pageFrom'] ?? ''),
      pageAtMost: int.tryParse(p['pageTo'] ?? ''),
      searchFavoriteCategoryIndex: int.tryParse(p['favcat'] ?? ''),
      disableFilterForLanguage: p['disableLanguageFilter'] == '1',
      disableFilterForUploader: p['disableUploaderFilter'] == '1',
      disableFilterForTags: p['disableTagFilter'] == '1',
    );
  }

  Future<void> _handleRanklist(HttpRequest request) async {
    final Map<String, String> params = request.uri.queryParameters;
    final int pageNo = int.tryParse(params['page'] ?? '') ?? 0;

    RanklistType ranklistType;
    switch (params['type']) {
      case 'allTime':
        ranklistType = RanklistType.allTime;
        break;
      case 'year':
        ranklistType = RanklistType.year;
        break;
      case 'month':
        ranklistType = RanklistType.month;
        break;
      default:
        ranklistType = RanklistType.day;
    }

    final List<dynamic> result = await _retryRequest(() => ehRequest.requestRanklistPage(
      ranklistType: ranklistType,
      pageNo: pageNo,
      parser: EHSpiderParser.ranklistPage2GalleryPageInfo,
    ));

    final List<Gallery> galleries = (result[0] as List).cast<Gallery>();

    await _sendJson(request, HttpStatus.ok, {
      'galleries': galleries.map(_galleryToJson).toList(),
      'pageCount': result[1],
      'prevPage': result[2],
      'nextPage': result[3],
    });
  }

  Future<void> _handleHistory(HttpRequest request) async {
    if (request.method == 'DELETE') {
      final int? gid = int.tryParse(request.uri.queryParameters['gid'] ?? '');
      if (gid != null) {
        await historyService.delete(gid);
      } else {
        await historyService.deleteAll();
      }
      return _sendJson(request, HttpStatus.ok, {'ok': true});
    }

    final int pageIndex = int.tryParse(request.uri.queryParameters['page'] ?? '') ?? 0;
    final int pageCount = await historyService.getPageCount();
    final List<dynamic> histories = await historyService.getByPageIndex(pageIndex);

    await _sendJson(request, HttpStatus.ok, {
      'pageCount': pageCount,
      'pageIndex': pageIndex,
      'galleries': histories.map((dynamic history) {
        return {
          'gid': history.galleryUrl.gid,
          'token': history.galleryUrl.token,
          'url': history.galleryUrl.url,
          'title': history.title,
          'category': history.category,
          'cover': history.coverUrl,
          'pageCount': history.pageCount,
          'rating': history.rating,
          'language': history.language,
          'uploader': history.uploader,
          'publishTime': history.publishTime,
          'tags': {'other': history.tags},
        };
      }).toList(),
    });
  }

  Future<void> _handleReadPages(HttpRequest request) async {
    final GalleryUrl? galleryUrl = GalleryUrl.tryParse(request.uri.queryParameters['url'] ?? '');
    if (galleryUrl == null) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
    }

    final int pageIndex = int.tryParse(request.uri.queryParameters['index'] ?? '') ?? 0;

    final info = await _retryRequest(() => ehRequest.requestDetailPage(
      galleryUrl: galleryUrl.url,
      thumbnailsPageIndex: pageIndex,
      parser: EHSpiderParser.detailPage2RangeAndThumbnails,
    ));

    await _sendJson(request, HttpStatus.ok, {
      'imageNoFrom': info.imageNoFrom,
      'imageNoTo': info.imageNoTo,
      'imageCount': info.imageCount,
      'currentPageNo': info.currentPageNo,
      'pageCount': info.pageCount,
      'thumbnailsCountPerPage': info.thumbnailsCountPerPage,
      'thumbnails': info.thumbnails
          .map((dynamic thumbnail) => {
                'href': thumbnail.href,
                'thumbUrl': thumbnail.thumbUrl,
                'isLarge': thumbnail.isLarge,
                'width': thumbnail.thumbWidth,
                'height': thumbnail.thumbHeight,
              })
          .toList(),
    });
  }

  Future<void> _handleReadImage(HttpRequest request) async {
    final String? href = request.uri.queryParameters['href'];
    final Uri? uri = href == null ? null : Uri.tryParse(href);
    if (uri == null || !_isGalleryHostAllowed(uri)) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'href not allowed'});
    }

    final image = await _retryRequest(() => ehRequest.requestImagePage(
      href!,
      parser: EHSpiderParser.imagePage2GalleryImage,
    ));

    await _sendJson(request, HttpStatus.ok, {
      'url': image.url,
      'originalImageUrl': image.originalImageUrl,
      'width': image.width,
      'height': image.height,
      'originalImageWidth': image.originalImageWidth,
      'originalImageHeight': image.originalImageHeight,
      'reloadKey': image.reloadKey,
    });
  }

  bool _isGalleryHostAllowed(Uri uri) {
    if (uri.scheme != 'http' && uri.scheme != 'https') {
      return false;
    }
    final String host = uri.host.toLowerCase();
    return host == 'e-hentai.org' || host == 'exhentai.org' || host.endsWith('.e-hentai.org') || host.endsWith('.exhentai.org');
  }

  Future<void> _handleTorrents(HttpRequest request) async {
    final GalleryUrl? galleryUrl = GalleryUrl.tryParse(request.uri.queryParameters['url'] ?? '');
    if (galleryUrl == null) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
    }

    final List<GalleryTorrent> torrents = await ehRequest.requestTorrentPage(
      galleryUrl.gid,
      galleryUrl.token,
      EHSpiderParser.torrentPage2GalleryTorrent,
    );

    await _sendJson(request, HttpStatus.ok, {
      'torrents': torrents
          .map((GalleryTorrent torrent) => {
                'title': torrent.title,
                'postTime': torrent.postTime,
                'size': torrent.size,
                'seeds': torrent.seeds,
                'peers': torrent.peers,
                'downloads': torrent.downloads,
                'uploader': torrent.uploader,
                'torrentUrl': torrent.torrentUrl,
                'magnetUrl': torrent.magnetUrl,
                'outdated': torrent.outdated,
              })
          .toList(),
    });
  }

  Future<void> _handleStats(HttpRequest request) async {
    final GalleryUrl? galleryUrl = GalleryUrl.tryParse(request.uri.queryParameters['url'] ?? '');
    if (galleryUrl == null) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
    }

    final GalleryStats stats = await ehRequest.requestStatPage(
      gid: galleryUrl.gid,
      token: galleryUrl.token,
      parser: EHSpiderParser.statPage2GalleryStats,
    );

    await _sendJson(request, HttpStatus.ok, {
      'totalVisits': stats.totalVisits,
      'allTimeRanking': stats.allTimeRanking,
      'allTimeScore': stats.allTimeScore,
      'yearRanking': stats.yearRanking,
      'yearScore': stats.yearScore,
      'monthRanking': stats.monthRanking,
      'monthScore': stats.monthScore,
      'dayRanking': stats.dayRanking,
      'dayScore': stats.dayScore,
      'yearly': stats.yearlyStats.map((dynamic s) => {'period': s.period, 'visits': s.visits, 'hits': s.hits}).toList(),
      'monthly': stats.monthlyStats.map((dynamic s) => {'period': s.period, 'visits': s.visits, 'hits': s.hits}).toList(),
      'daily': stats.dailyStats.map((dynamic s) => {'period': s.period, 'visits': s.visits, 'hits': s.hits}).toList(),
    });
  }

  Future<void> _handleArchive(HttpRequest request) async {
    final String archiveUrl = await _resolveArchivePageUrl(request);
    if (archiveUrl.isEmpty) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
    }

    final GalleryArchive archive = await _retryRequest(() => ehRequest.get(
      url: archiveUrl,
      parser: EHSpiderParser.archivePage2Archive,
    ));

    await _sendJson(request, HttpStatus.ok, {
      'archivePageUrl': archiveUrl,
      'gpCount': archive.gpCount,
      'creditCount': archive.creditCount,
      'originalCost': archive.originalCost,
      'originalSize': archive.originalSize,
      'originalSizeBytes': _parseArchiveSize(archive.originalSize),
      'downloadOriginalHint': archive.downloadOriginalHint,
      'resampleCost': archive.resampleCost,
      'resampleSize': archive.resampleSize,
      'resampleSizeBytes': archive.resampleSize == null ? null : _parseArchiveSize(archive.resampleSize!),
      'downloadResampleHint': archive.downloadResampleHint,
    });
  }

  Future<void> _handleArchiveDownload(HttpRequest request) async {
    final Map<String, dynamic> body = await _readJsonBody(request);
    final GalleryUrl? galleryUrl = GalleryUrl.tryParse(body['url']?.toString() ?? '');
    if (galleryUrl == null) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
    }

    final bool isOriginal = body['original'] != false;
    final String group = (body['group']?.toString().trim().isNotEmpty ?? false)
        ? body['group'].toString().trim()
        : (downloadSetting.defaultArchiveGroup.value ?? 'default'.tr);

    final ({GalleryDetail galleryDetails, String apikey}) detailResult = await _retryRequest(() => ehRequest.requestDetailPage(
      galleryUrl: galleryUrl.url,
      parser: EHSpiderParser.detailPage2GalleryAndDetailAndApikey,
    ));
    final GalleryDetail detail = detailResult.galleryDetails;

    final GalleryArchive archiveInfo = await _retryRequest(() => ehRequest.get(
      url: detail.archivePageUrl,
      parser: EHSpiderParser.archivePage2Archive,
    ));

    final String sizeString = isOriginal ? archiveInfo.originalSize : (archiveInfo.resampleSize ?? archiveInfo.originalSize);

    final ArchiveDownloadedData archive = ArchiveDownloadedData(
      gid: detail.galleryUrl.gid,
      token: detail.galleryUrl.token,
      title: detail.japaneseTitle ?? detail.rawTitle,
      category: detail.category,
      pageCount: detail.pageCount,
      galleryUrl: detail.galleryUrl.url,
      uploader: detail.uploader,
      size: _parseArchiveSize(sizeString),
      coverUrl: detail.cover.url,
      publishTime: detail.publishTime,
      archiveStatusCode: ArchiveStatus.unlocking.code,
      archivePageUrl: detail.archivePageUrl,
      isOriginal: isOriginal,
      insertTime: DateTime.now().toString(),
      sortOrder: 0,
      groupName: group,
      tags: tagMap2TagString(detail.tags),
      tagRefreshTime: DateTime.now().toString(),
      parseSource: ArchiveParseSource.official.code,
    );

    unawaited(() async {
      try {
        await archiveDownloadService.downloadArchive(archive);
      } catch (e, stack) {
        log.error('Web server failed to start archive download, gid: ${archive.gid}', e, stack);
      }
    }());

    await _sendJson(request, HttpStatus.ok, {'ok': true, 'gid': archive.gid});
  }

  Future<void> _handleHH(HttpRequest request) async {
    if (request.method == 'POST') {
      final Map<String, dynamic> body = await _readJsonBody(request);
      final String archiveUrl = body['archiveUrl']?.toString() ?? await _resolveArchivePageUrl(request);
      if (archiveUrl.isEmpty) {
        return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
      }
      final String resolution = body['resolution']?.toString() ?? '';

      final String result = await ehRequest.requestHHDownload(
        url: archiveUrl,
        resolution: resolution,
        parser: EHSpiderParser.downloadHHPage2Result,
      );

      return _sendJson(request, HttpStatus.ok, {'result': result});
    }

    final String archiveUrl = await _resolveArchivePageUrl(request);
    if (archiveUrl.isEmpty) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
    }

    final GalleryHHInfo info = await _retryRequest(() => ehRequest.get(
      url: archiveUrl,
      parser: EHSpiderParser.archivePage2HHInfo,
    ));

    await _sendJson(request, HttpStatus.ok, {
      'gpCount': info.gpCount,
      'creditCount': info.creditCount,
      'archives': info.archives
          .map((dynamic archive) => {
                'resolutionDesc': archive.resolutionDesc,
                'resolution': archive.resolution,
                'size': archive.size,
                'cost': archive.cost,
              })
          .toList(),
    });
  }

  Future<String> _resolveArchivePageUrl(HttpRequest request) async {
    final String? archiveUrl = request.uri.queryParameters['archiveUrl'];
    if (archiveUrl != null && archiveUrl.isNotEmpty) {
      return archiveUrl;
    }

    final GalleryUrl? galleryUrl = GalleryUrl.tryParse(request.uri.queryParameters['url'] ?? '');
    if (galleryUrl == null) {
      return '';
    }

    final ({GalleryDetail galleryDetails, String apikey}) result = await _retryRequest(() => ehRequest.requestDetailPage(
      galleryUrl: galleryUrl.url,
      parser: EHSpiderParser.detailPage2GalleryAndDetailAndApikey,
    ));
    return result.galleryDetails.archivePageUrl;
  }

  int _parseArchiveSize(String sizeString) {
    final List<String> parts = sizeString.trim().split(RegExp(r'\s+'));
    if (parts.isEmpty) {
      return 0;
    }
    final double number = double.tryParse(parts[0]) ?? 0;
    final String unit = parts.length > 1 ? parts[1] : 'B';
    if (unit.startsWith('K')) {
      return (number * 1024).toInt();
    }
    if (unit.startsWith('M')) {
      return (number * 1024 * 1024).toInt();
    }
    if (unit.startsWith('G')) {
      return (number * 1024 * 1024 * 1024).toInt();
    }
    return number.toInt();
  }

  Future<void> _handleFavoriteAction(HttpRequest request) async {
    if (!userSetting.hasLoggedIn()) {
      return _sendJson(request, HttpStatus.forbidden, {'error': 'login required'});
    }

    final Map<String, dynamic> body = await _readJsonBody(request);
    final GalleryUrl? galleryUrl = GalleryUrl.tryParse(body['url']?.toString() ?? '');
    if (galleryUrl == null) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
    }

    if (body['remove'] == true) {
      await ehRequest.requestRemoveFavorite<dynamic>(galleryUrl.gid, galleryUrl.token);
      return _sendJson(request, HttpStatus.ok, {'ok': true, 'favorite': false});
    }

    final int favcat = int.tryParse(body['favcat']?.toString() ?? '') ?? 0;
    final String note = body['note']?.toString() ?? '';
    await ehRequest.requestAddFavorite<dynamic>(galleryUrl.gid, galleryUrl.token, favcat, note);

    await _sendJson(request, HttpStatus.ok, {'ok': true, 'favorite': true, 'favcat': favcat});
  }

  Future<void> _handleRating(HttpRequest request) async {
    if (!userSetting.hasLoggedIn()) {
      return _sendJson(request, HttpStatus.forbidden, {'error': 'login required'});
    }

    final Map<String, dynamic> body = await _readJsonBody(request);
    final GalleryUrl? galleryUrl = GalleryUrl.tryParse(body['url']?.toString() ?? '');
    if (galleryUrl == null) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
    }

    String? apikey = body['apikey']?.toString();
    if (apikey == null || apikey.isEmpty) {
      final ({GalleryDetail galleryDetails, String apikey}) result = await _retryRequest(() => ehRequest.requestDetailPage(
        galleryUrl: galleryUrl.url,
        parser: EHSpiderParser.detailPage2GalleryAndDetailAndApikey,
      ));
      apikey = result.apikey;
    }

    final double rating = double.tryParse(body['rating']?.toString() ?? '') ?? 0;
    final Map<String, dynamic> ratingInfo = await ehRequest.requestSubmitRating(
      galleryUrl.gid,
      galleryUrl.token,
      userSetting.ipbMemberId.value!,
      apikey,
      (rating * 2).round(),
      EHSpiderParser.galleryRatingResponse2RatingInfo,
    );

    await _sendJson(request, HttpStatus.ok, {'ok': true, 'rating': ratingInfo});
  }

  Future<void> _handleComment(HttpRequest request) async {
    if (!userSetting.hasLoggedIn()) {
      return _sendJson(request, HttpStatus.forbidden, {'error': 'login required'});
    }

    final Map<String, dynamic> body = await _readJsonBody(request);
    final GalleryUrl? galleryUrl = GalleryUrl.tryParse(body['url']?.toString() ?? '');
    final String content = body['content']?.toString() ?? '';
    if (galleryUrl == null || content.trim().isEmpty) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid comment'});
    }

    final int? commentId = int.tryParse(body['commentId']?.toString() ?? '');
    final String? errorMessage;
    if (commentId == null) {
      errorMessage = await ehRequest.requestSendComment(
        galleryUrl: galleryUrl.url,
        content: content,
        parser: EHSpiderParser.sendComment2ErrorMsg,
      );
    } else {
      errorMessage = await ehRequest.requestUpdateComment(
        galleryUrl: galleryUrl.url,
        content: content,
        commentId: commentId,
        parser: EHSpiderParser.sendComment2ErrorMsg,
      );
    }

    await _sendJson(request, HttpStatus.ok, {'ok': errorMessage == null, 'error': errorMessage});
  }

  Future<void> _handleAppearance(HttpRequest request) async {
    if (request.method == 'GET') {
      return _sendJson(request, HttpStatus.ok, {
        'themeMode': styleSetting.themeMode.value.name,
        'lightColor': _colorToHex(styleSetting.lightThemeColor.value),
        'darkColor': _colorToHex(styleSetting.darkThemeColor.value),
        'locale': preferenceSetting.locale.value.toString(),
        'site': ehSetting.site.value,
        'locales': const ['en_US', 'zh_CN', 'zh_TW', 'ko_KR', 'pt_BR'],
        'sites': const ['EH', 'EX'],
      });
    }

    if (request.method != 'POST') {
      return _sendJson(request, HttpStatus.methodNotAllowed, {'error': 'method not allowed'});
    }

    final Map<String, dynamic> body = await _readJsonBody(request);

    if (body['themeMode'] is String) {
      final ThemeMode mode = switch (body['themeMode'] as String) {
        'light' => ThemeMode.light,
        'dark' => ThemeMode.dark,
        _ => ThemeMode.system,
      };
      await styleSetting.saveThemeMode(mode);
    }
    if (body['lightColor'] is String) {
      await styleSetting.saveLightThemeColor(_hexToColor(body['lightColor'] as String));
    }
    if (body['darkColor'] is String) {
      await styleSetting.saveDarkThemeColor(_hexToColor(body['darkColor'] as String));
    }
    if (body['locale'] is String) {
      await preferenceSetting.saveLanguage(localeCode2Locale(body['locale'] as String));
    }
    if (body['site'] is String) {
      await ehSetting.saveSite(body['site'] as String);
    }

    await _sendJson(request, HttpStatus.ok, {'ok': true});
  }

  String _colorToHex(Color color) {
    return '#${color.toARGB32().toRadixString(16).padLeft(8, '0').substring(2)}';
  }

  Color _hexToColor(String hex) {
    String value = hex.replaceFirst('#', '').trim();
    if (value.length == 6) {
      value = 'ff$value';
    }
    return Color(int.parse(value, radix: 16));
  }

  Future<void> _handleNetwork(HttpRequest request) async {
    if (request.method == 'GET') {
      return _sendJson(request, HttpStatus.ok, {
        'proxyType': networkSetting.proxyType.value.name,
        'proxyAddress': networkSetting.proxyAddress.value,
        'proxyUsername': networkSetting.proxyUsername.value,
        'proxyPassword': networkSetting.proxyPassword.value,
        'connectTimeout': networkSetting.connectTimeout.value,
        'receiveTimeout': networkSetting.receiveTimeout.value,
        'enableDomainFronting': networkSetting.enableDomainFronting.value,
        'pageCacheMaxAge': networkSetting.pageCacheMaxAge.value.inMinutes,
      });
    }

    if (request.method != 'POST') {
      return _sendJson(request, HttpStatus.methodNotAllowed, {'error': 'method not allowed'});
    }

    final Map<String, dynamic> body = await _readJsonBody(request);

    if (body['proxyType'] is String) {
      final JProxyType proxyType = JProxyType.values.firstWhere(
        (JProxyType type) => type.name == body['proxyType'],
        orElse: () => networkSetting.proxyType.value,
      );
      await networkSetting.saveProxy(
        proxyType,
        body['proxyAddress']?.toString() ?? networkSetting.proxyAddress.value,
        body['proxyUsername']?.toString(),
        body['proxyPassword']?.toString(),
      );
    }
    if (body['connectTimeout'] is int) {
      await networkSetting.saveConnectTimeout(body['connectTimeout'] as int);
    }
    if (body['receiveTimeout'] is int) {
      await networkSetting.saveReceiveTimeout(body['receiveTimeout'] as int);
    }
    if (body['enableDomainFronting'] is bool) {
      await networkSetting.saveEnableDomainFronting(body['enableDomainFronting'] as bool);
    }

    await _sendJson(request, HttpStatus.ok, {'ok': true});
  }

  Future<void> _handleFilters(HttpRequest request) async {
    await _sendJson(request, HttpStatus.ok, {
      'categories': const [
        'Doujinshi',
        'Manga',
        'Artist CG',
        'Game CG',
        'Image Set',
        'Cosplay',
        'Non-H',
        'Western',
        'Asian Porn',
        'Misc',
      ],
      'favorites': favoriteSetting.favoriteTagNames,
      'groups': galleryDownloadService.allGroups,
      'archiveGroups': archiveDownloadService.allGroups,
      'defaultGroup': downloadSetting.defaultGalleryGroup.value,
      'defaultArchiveGroup': downloadSetting.defaultArchiveGroup.value,
      'user': {
        'loggedIn': userSetting.hasLoggedIn(),
        'userName': userSetting.userName.value,
        'nickName': userSetting.nickName.value,
        'avatar': userSetting.avatarImgUrl.value,
        'defaultFavoriteIndex': userSetting.defaultFavoriteIndex.value,
        'site': ehSetting.site.value,
      },
    });
  }

  Future<void> _handleProgress(HttpRequest request) async {
    int? gid = int.tryParse(request.uri.queryParameters['gid'] ?? '');

    if (request.method == 'POST') {
      final Map<String, dynamic> body = await _readJsonBody(request);
      gid ??= int.tryParse(body['gid']?.toString() ?? '');
      if (gid == null) {
        return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gid'});
      }
      final int index = int.tryParse(body['index']?.toString() ?? '') ?? 0;
      await readProgressService.updateReadProgress(gid.toString(), index);
      return _sendJson(request, HttpStatus.ok, {'ok': true, 'index': index});
    }

    if (gid == null) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gid'});
    }
    final int index = await readProgressService.getReadProgress(gid);
    await _sendJson(request, HttpStatus.ok, {'index': index});
  }

  Future<void> _handleArchiveTasks(HttpRequest request) async {
    final List<Map<String, dynamic>> tasks = [];
    for (final ArchiveDownloadedData archive in archiveDownloadService.archives) {
      final ArchiveDownloadInfo? info = archiveDownloadService.archiveDownloadInfos[archive.gid];
      if (info == null) {
        continue;
      }
      tasks.add({
        'gid': archive.gid,
        'url': archive.galleryUrl,
        'title': archive.title,
        'category': archive.category,
        'pageCount': archive.pageCount,
        'cover': '/api/archive-library/${archive.gid}/cover',
        'size': info.size,
        'downloaded': info.speedComputer.downloadedBytes,
        'speed': info.archiveStatus == ArchiveStatus.downloading ? info.speedComputer.speed : '',
        'status': info.archiveStatus.name,
        'group': info.group,
        'isOriginal': archive.isOriginal,
        'publishTime': archive.publishTime,
        'uploader': archive.uploader,
        'hasFiles': Directory(archiveDownloadService.computeArchiveUnpackingPath(archive)).existsSync(),
      });
    }

    await _sendJson(request, HttpStatus.ok, {'tasks': tasks});
  }

  Future<void> _handleArchiveTaskAction(HttpRequest request, int gid, String action) async {
    if (!archiveDownloadService.archiveDownloadInfos.containsKey(gid)) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'archive task not found'});
    }

    switch (action) {
      case 'pause':
        await archiveDownloadService.pauseDownloadArchive(gid);
        break;
      case 'resume':
        await archiveDownloadService.resumeDownloadArchive(gid);
        break;
      case 'cancel':
        await archiveDownloadService.cancelArchive(gid);
        break;
      case 'delete':
        await archiveDownloadService.deleteArchive(gid);
        break;
      default:
        return _sendJson(request, HttpStatus.badRequest, {'error': 'unknown action'});
    }

    await _sendJson(request, HttpStatus.ok, {'ok': true});
  }

  Future<void> _handleArchiveLibraryDetail(HttpRequest request, int gid) async {
    ArchiveDownloadedData? archive;
    for (final ArchiveDownloadedData candidate in archiveDownloadService.archives) {
      if (candidate.gid == gid) {
        archive = candidate;
        break;
      }
    }
    if (archive == null) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'archive not found'});
    }

    final List<GalleryImage> images = await archiveDownloadService.getUnpackedImages(gid);

    await _sendJson(request, HttpStatus.ok, {
      'gid': archive.gid,
      'title': archive.title,
      'category': archive.category,
      'pageCount': archive.pageCount,
      'cover': '/api/archive-library/${archive.gid}/cover',
      'images': [
        for (int i = 0; i < images.length; i++)
          {
            'serialNo': i,
            'local': true,
            'url': '/api/archive-library/${archive.gid}/file/$i',
          }
      ],
    });
  }

  Future<void> _serveArchiveLibraryImage(HttpRequest request, int gid, int serialNo) async {
    ArchiveDownloadedData? archive;
    for (final ArchiveDownloadedData candidate in archiveDownloadService.archives) {
      if (candidate.gid == gid) {
        archive = candidate;
        break;
      }
    }
    if (archive == null) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'archive not found'});
    }

    final List<GalleryImage> images = await archiveDownloadService.getUnpackedImages(gid);
    if (serialNo < 0 || serialNo >= images.length) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'image not found'});
    }

    final File? file = _imageFileFromRelative(images[serialNo].path);
    if (file == null || !await file.exists()) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'image not found'});
    }

    await _serveFile(request, file);
  }

  Future<void> _handleLocalGalleries(HttpRequest request) async {
    final Directory visibleDir = pathService.getVisibleDir();
    final List<Map<String, dynamic>> galleries = localGalleryService.allGalleries.map((dynamic gallery) {
      final String relativePath = p.relative(gallery.path, from: visibleDir.path);
      return {
        'title': gallery.title,
        'path': relativePath,
        'cover': '/api/local-galleries/cover?path=${Uri.encodeQueryComponent(relativePath)}',
      };
    }).toList();

    await _sendJson(request, HttpStatus.ok, {'galleries': galleries});
  }

  Future<void> _handleLocalGalleryImages(HttpRequest request) async {
    final String relativePath = request.uri.queryParameters['path'] ?? '';
    final Directory? directory = _safeVisibleDirectory(relativePath);
    if (directory == null || !await directory.exists()) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'gallery not found'});
    }

    final List<File> files = directory
        .listSync()
        .whereType<File>()
        .where((File file) => FileUtil.isImageExtension(file.path))
        .toList()
      ..sort(FileUtil.naturalCompareFile);

    await _sendJson(request, HttpStatus.ok, {
      'title': p.basename(directory.path),
      'path': relativePath,
      'images': [
        for (int i = 0; i < files.length; i++)
          {
            'serialNo': i,
            'local': true,
            'url': '/api/local-galleries/file?path=${Uri.encodeQueryComponent(relativePath)}&index=$i',
          }
      ],
    });
  }

  Future<void> _serveLocalGalleryImage(HttpRequest request, int index) async {
    final String relativePath = request.uri.queryParameters['path'] ?? '';
    final Directory? directory = _safeVisibleDirectory(relativePath);
    if (directory == null || !await directory.exists()) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'gallery not found'});
    }

    final List<File> files = directory
        .listSync()
        .whereType<File>()
        .where((File file) => FileUtil.isImageExtension(file.path))
        .toList()
      ..sort(FileUtil.naturalCompareFile);

    if (index < 0 || index >= files.length) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'image not found'});
    }

    await _serveFile(request, files[index]);
  }

  Directory? _safeVisibleDirectory(String relativePath) {
    if (relativePath.isEmpty || relativePath.contains('..')) {
      return null;
    }
    final String root = p.normalize(pathService.getVisibleDir().path);
    final String target = p.normalize(p.join(root, relativePath));
    if (target != root && !p.isWithin(root, target)) {
      return null;
    }
    return Directory(target);
  }

  File? _imageFileFromRelative(String? relativePath) {
    if (relativePath == null || relativePath.isEmpty) {
      return null;
    }
    if (p.isAbsolute(relativePath)) {
      return File(relativePath);
    }
    return File(p.join(pathService.getVisibleDir().path, relativePath));
  }

  Future<void> _handleGalleryDetail(HttpRequest request) async {
    final String? rawUrl = request.uri.queryParameters['url'];
    final GalleryUrl? galleryUrl = rawUrl == null ? null : GalleryUrl.tryParse(rawUrl);
    if (galleryUrl == null) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
    }

    final ({GalleryDetail galleryDetails, String apikey}) result = await _retryRequest(() => ehRequest.requestDetailPage(
      galleryUrl: galleryUrl.url,
      parser: EHSpiderParser.detailPage2GalleryAndDetailAndApikey,
    ));

    final GalleryDetail detail = result.galleryDetails;

    if (request.uri.queryParameters['record'] != '0') {
      unawaited(historyService.record(galleryDetail2GalleryHistoryModel(detail)));
    }

    await _sendJson(request, HttpStatus.ok, {
      ..._detailToJson(detail),
      'apikey': result.apikey,
      'apiuid': userSetting.ipbMemberId.value,
      'readProgress': await readProgressService.getReadProgress(detail.galleryUrl.gid),
      'comments': detail.comments.map(_commentToJson).toList(),
    });
  }

  Future<void> _handleCreateDownload(HttpRequest request) async {
    final Map<String, dynamic> body = await _readJsonBody(request);
    final GalleryUrl? galleryUrl = GalleryUrl.tryParse(body['url']?.toString() ?? '');
    if (galleryUrl == null) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'invalid gallery url'});
    }

    if (galleryDownloadService.containGallery(galleryUrl.gid)) {
      return _sendJson(request, HttpStatus.ok, {'ok': true, 'alreadyExists': true, 'gid': galleryUrl.gid});
    }

    final ({GalleryDetail galleryDetails, String apikey}) result = await _retryRequest(() => ehRequest.requestDetailPage(
      galleryUrl: galleryUrl.url,
      parser: EHSpiderParser.detailPage2GalleryAndDetailAndApikey,
    ));
    final GalleryDetail detail = result.galleryDetails;

    final bool packAsCbz = body['cbz'] == true;
    final bool downloadOriginal = body['original'] == true && userSetting.hasLoggedIn();
    final String group = (body['group']?.toString().trim().isNotEmpty ?? false)
        ? body['group'].toString().trim()
        : (downloadSetting.defaultGalleryGroup.value ?? 'default'.tr);

    if (packAsCbz) {
      CbzService.instance.markGalleryForCbz(detail.galleryUrl.gid);
    }

    final GalleryDownloadRequest downloadRequest = GalleryDownloadRequest(
      gid: detail.galleryUrl.gid,
      token: detail.galleryUrl.token,
      title: detail.japaneseTitle ?? detail.rawTitle,
      category: detail.category,
      pageCount: detail.pageCount,
      galleryUrl: detail.galleryUrl.url,
      uploader: detail.uploader,
      publishTime: detail.publishTime,
      downloadOriginalImage: downloadOriginal,
      group: group,
      tags: tagMap2TagString(detail.tags),
      tagRefreshTime: DateTime.now().toString(),
    );

    unawaited(() async {
      try {
        await galleryDownloadService.downloadGallery(downloadRequest);
      } catch (e, stack) {
        log.error('Web server failed to start download, gid: ${downloadRequest.gid}', e, stack);
      }
    }());

    await _sendJson(request, HttpStatus.ok, {'ok': true, 'gid': detail.galleryUrl.gid, 'cbz': packAsCbz});
  }

  Future<void> _handleTasks(HttpRequest request) async {
    final List<Map<String, dynamic>> tasks = galleryDownloadService.galleries.map(_taskToJson).toList();
    await _sendJson(request, HttpStatus.ok, {'tasks': tasks});
  }

  Future<void> _handleTaskAction(HttpRequest request, int gid, String action) async {
    final GalleryDownloadInfo? info = galleryDownloadService.galleryDownloadInfos[gid];
    if (info == null) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'task not found'});
    }

    switch (action) {
      case 'pause':
        await galleryDownloadService.pauseDownloadGallery(info);
        break;
      case 'resume':
        await galleryDownloadService.resumeDownloadGallery(info);
        break;
      case 'delete':
        await galleryDownloadService.deleteGallery(info);
        break;
      default:
        return _sendJson(request, HttpStatus.badRequest, {'error': 'unknown action'});
    }

    await _sendJson(request, HttpStatus.ok, {'ok': true});
  }

  Future<void> _handleLibrary(HttpRequest request) async {
    final bool includeAll = request.uri.queryParameters['all'] == '1';
    final List<Map<String, dynamic>> galleries = galleryDownloadService.galleries
        .where((GalleryDownloadInfo info) => includeAll || info.downloadProgress.downloadStatus == DownloadStatus.downloaded)
        .map(_taskToJson)
        .toList();

    await _sendJson(request, HttpStatus.ok, {'galleries': galleries});
  }

  Future<void> _handleLibraryDetail(HttpRequest request, int gid) async {
    final GalleryDownloadInfo? info = galleryDownloadService.galleryDownloadInfos[gid];
    if (info == null) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'gallery not found'});
    }

    await info.ensureImagesLoaded();
    final List<GalleryImage?> images = info.images ?? <GalleryImage?>[];

    await _sendJson(request, HttpStatus.ok, {
      ..._taskToJson(info),
      'images': [
        for (int serialNo = 0; serialNo < images.length; serialNo++)
          {
            'serialNo': serialNo,
            'url': images[serialNo]?.url,
            'local': _imageFile(info, images[serialNo])?.existsSync() ?? false,
            'downloaded': images[serialNo]?.downloadStatus == DownloadStatus.downloaded,
          }
      ],
    });
  }

  Future<void> _handleLibraryImages(HttpRequest request, int gid) async {
    final GalleryDownloadInfo? info = galleryDownloadService.galleryDownloadInfos[gid];
    if (info == null) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'gallery not found'});
    }

    await info.ensureImagesLoaded();
    final List<GalleryImage?> images = info.images ?? <GalleryImage?>[];

    await _sendJson(request, HttpStatus.ok, {
      'images': [
        for (int serialNo = 0; serialNo < images.length; serialNo++)
          {
            'serialNo': serialNo,
            'url': images[serialNo]?.url,
            'local': _imageFile(info, images[serialNo])?.existsSync() ?? false,
          }
      ],
    });
  }

  Future<void> _serveCover(HttpRequest request, int gid) async {
    final GalleryDownloadInfo? info = galleryDownloadService.galleryDownloadInfos[gid];
    if (info == null) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'gallery not found'});
    }

    final File? local = _imageFile(info, info.coverImage);
    if (local != null && await local.exists()) {
      return _serveFile(request, local);
    }

    final String? remote = info.coverImage?.url;
    if (remote == null || remote.isEmpty) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'cover not available'});
    }

    await request.response.redirect(Uri.parse(_proxyRedirectLocation(remote)));
  }

  String _proxyRedirectLocation(String remote) {
    String location = '/api/proxy?url=${Uri.encodeQueryComponent(remote)}';
    final String expected = webServerSetting.token.value.trim();
    if (expected.isNotEmpty) {
      location += '&token=${Uri.encodeQueryComponent(expected)}';
    }
    return location;
  }

  Future<void> _serveLibraryImage(HttpRequest request, int gid, int serialNo) async {
    final GalleryDownloadInfo? info = galleryDownloadService.galleryDownloadInfos[gid];
    if (info == null) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'gallery not found'});
    }

    await info.ensureImagesLoaded();
    final GalleryImage? image = (serialNo >= 0 && serialNo < (info.images?.length ?? 0)) ? info.images![serialNo] : null;

    final File? local = _imageFile(info, image);
    if (local != null && await local.exists()) {
      return _serveFile(request, local);
    }

    final String? remote = image?.url;
    if (remote == null || remote.isEmpty) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'image not available'});
    }

    await request.response.redirect(Uri.parse(_proxyRedirectLocation(remote)));
  }

  Future<void> _serveCbz(HttpRequest request, int gid) async {
    final GalleryDownloadInfo? info = galleryDownloadService.galleryDownloadInfos[gid];
    if (info == null) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'gallery not found'});
    }

    final String galleryDirectory = DownloadPathResolver.computeGalleryDownloadAbsolutePath(info.toGalleryDownloadedData());
    final String cbzPath = CbzService.cbzPathForDirectory(galleryDirectory);
    final File cbz = File(cbzPath);

    if (!await cbz.exists()) {
      if (!await Directory(galleryDirectory).exists()) {
        return _sendJson(request, HttpStatus.notFound, {'error': 'gallery files not found'});
      }

      await CbzService.instance.packDirectory(
        sourceDir: galleryDirectory,
        outputPath: cbzPath,
        deleteSource: request.uri.queryParameters['deleteSource'] == '1',
      );
    }

    await _serveFile(request, cbz, downloadName: p.basename(cbz.path));
  }

  Future<void> _handleProxy(HttpRequest request) async {
    final String? rawUrl = request.uri.queryParameters['url'];
    final Uri? uri = rawUrl == null ? null : Uri.tryParse(rawUrl);
    if (uri == null || !_isProxyHostAllowed(uri)) {
      return _sendJson(request, HttpStatus.badRequest, {'error': 'url not allowed'});
    }

    final String key = uri.toString();
    final ({Uint8List bytes, String contentType})? cachedResource = _proxyCache[key];
    final ({Uint8List bytes, String contentType}) resource;
    if (cachedResource != null) {
      resource = cachedResource;
    } else {
      final ({Uint8List bytes, String contentType}) fetched = await _withProxySlot(() => _fetchProxyResource(key));
      resource = fetched;
      if (fetched.bytes.length <= (2 << 20) && _proxyCacheBytes + fetched.bytes.length <= _proxyCacheMaxBytes) {
        _proxyCache[key] = fetched;
        _proxyCacheBytes += fetched.bytes.length;
      }
    }

    request.response.headers.set(HttpHeaders.contentTypeHeader, resource.contentType);
    request.response.headers.set(HttpHeaders.cacheControlHeader, 'public, max-age=3600');
    request.response.contentLength = resource.bytes.length;
    request.response.add(resource.bytes);
    await request.response.close();
  }

  Future<({Uint8List bytes, String contentType})> _fetchProxyResource(String url) async {
    /// Some image CDNs (ehgt.org) are reachable directly even when the
    /// E-Hentai front-end is not. Try direct first: it avoids sending every
    /// thumbnail through a possibly slow or down proxy.
    try {
      return await _fetchDirectResource(url);
    } catch (_) {}

    Object? lastError;
    for (int attempt = 0; attempt < 2; attempt++) {
      try {
        final response = await ehRequest.runWithConnectTimeout(
          const Duration(seconds: 15),
          () => ehRequest.requestBytes(
            url,
            receiveTimeout: const Duration(seconds: 45),
          ),
        );
        final List<int> data = response.data ?? const <int>[];
        return (
          bytes: data is Uint8List ? data : Uint8List.fromList(data),
          contentType: response.headers.map['content-type']?.first ?? 'application/octet-stream',
        );
      } catch (e) {
        lastError = e;
        if (attempt < 1) {
          await Future<void>.delayed(const Duration(milliseconds: 300));
        }
      }
    }
    throw lastError ?? Exception('Failed to fetch $url');
  }

  Future<({Uint8List bytes, String contentType})> _fetchDirectResource(String url) async {
    final Uri? uri = Uri.tryParse(url);
    if (uri == null) {
      throw ArgumentError.value(url, 'url');
    }

    final HttpClient client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 8)
      ..idleTimeout = const Duration(seconds: 10)
      ..findProxy = ((Uri _) => 'DIRECT');

    try {
      final HttpClientRequest request = await client.getUrl(uri);
      request.headers.set(HttpHeaders.userAgentHeader, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 JHenTai');
      request.headers.set(HttpHeaders.refererHeader, 'https://e-hentai.org/');
      request.headers.set(HttpHeaders.acceptHeader, 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8');
      final HttpClientResponse response = await request.close();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw HttpException('HTTP ${response.statusCode}', uri: uri);
      }
      final BytesBuilder builder = BytesBuilder(copy: false);
      await for (final List<int> chunk in response) {
        builder.add(chunk);
      }
      return (
        bytes: builder.takeBytes(),
        contentType: response.headers.contentType?.toString() ?? 'application/octet-stream',
      );
    } finally {
      client.close(force: true);
    }
  }

  Future<T> _withProxySlot<T>(Future<T> Function() task) async {
    if (_proxyActive >= _proxyConcurrency) {
      final Completer<void> waiter = Completer<void>();
      _proxyQueue.add(waiter);
      await waiter.future;
    }

    _proxyActive++;
    try {
      return await task();
    } finally {
      _proxyActive--;
      if (_proxyQueue.isNotEmpty) {
        _proxyQueue.removeAt(0).complete();
      }
    }
  }

  bool _isProxyHostAllowed(Uri uri) {
    if (uri.scheme != 'http' && uri.scheme != 'https') {
      return false;
    }
    final String host = uri.host.toLowerCase();
    return _proxyHostSuffixes.any((String suffix) => host == suffix || host.endsWith('.$suffix'));
  }

  Future<void> _handleSettings(HttpRequest request) async {
    if (request.method == 'GET') {
      return _sendJson(request, HttpStatus.ok, {
        'downloadAsCbz': downloadSetting.downloadAsCbz.value,
        'deleteImagesAfterCbz': downloadSetting.deleteImagesAfterCbz.value,
        'hasToken': webServerSetting.token.value.isNotEmpty,
        'token': webServerSetting.token.value,
        'port': webServerSetting.port.value,
        'allowRemote': webServerSetting.allowRemote.value,
        'address': webServerService.address,
        'running': webServerService.running.value,
      });
    }

    if (request.method != 'POST') {
      return _sendJson(request, HttpStatus.methodNotAllowed, {'error': 'method not allowed'});
    }

    final Map<String, dynamic> body = await _readJsonBody(request);
    if (body['downloadAsCbz'] is bool) {
      await downloadSetting.saveDownloadAsCbz(body['downloadAsCbz'] as bool);
    }
    if (body['deleteImagesAfterCbz'] is bool) {
      await downloadSetting.saveDeleteImagesAfterCbz(body['deleteImagesAfterCbz'] as bool);
    }
    if (body['token'] is String) {
      await webServerSetting.saveToken(body['token'] as String);
    }

    bool restart = false;
    if (body['port'] is int) {
      final int port = body['port'] as int;
      if (port >= 1 && port <= 65535 && port != webServerSetting.port.value) {
        await webServerSetting.savePort(port);
        restart = true;
      }
    }
    if (body['allowRemote'] is bool && body['allowRemote'] != webServerSetting.allowRemote.value) {
      await webServerSetting.saveAllowRemote(body['allowRemote'] as bool);
      restart = true;
    }

    await _sendJson(request, HttpStatus.ok, {'ok': true, 'restart': restart});
    if (restart && webServerService.running.value) {
      unawaited(Future<void>.delayed(const Duration(milliseconds: 300), webServerService.restart));
    }
  }

  Map<String, dynamic> _galleryToJson(Gallery gallery) {
    return {
      'gid': gallery.gid,
      'token': gallery.token,
      'url': gallery.galleryUrl.url,
      'title': gallery.title,
      'category': gallery.category,
      'cover': gallery.cover.url,
      'pageCount': gallery.pageCount,
      'rating': gallery.rating,
      'uploader': gallery.uploader,
      'publishTime': gallery.publishTime,
      'language': gallery.language,
      'hasRated': gallery.hasRated,
      'isFavorite': gallery.isFavorite,
      'favoriteTagIndex': gallery.favoriteTagIndex,
      'favoriteTagName': gallery.favoriteTagName,
      'isExpunged': gallery.isExpunged,
      'tags': {
        for (final MapEntry<String, List<GalleryTag>> entry in gallery.tags.entries)
          entry.key: entry.value.map((GalleryTag tag) => tag.tagData.key).toList(),
      },
    };
  }

  Map<String, dynamic> _detailToJson(GalleryDetail detail) {
    return {
      'gid': detail.galleryUrl.gid,
      'token': detail.galleryUrl.token,
      'url': detail.galleryUrl.url,
      'title': detail.japaneseTitle ?? detail.rawTitle,
      'rawTitle': detail.rawTitle,
      'japaneseTitle': detail.japaneseTitle,
      'category': detail.category,
      'cover': detail.cover.url,
      'pageCount': detail.pageCount,
      'rating': detail.realRating,
      'userRating': detail.rating,
      'hasRated': detail.hasRated,
      'ratingCount': detail.ratingCount,
      'favoriteCount': detail.favoriteCount,
      'isFavorite': detail.isFavorite,
      'favoriteTagIndex': detail.favoriteTagIndex,
      'favoriteTagName': detail.favoriteTagName,
      'uploader': detail.uploader,
      'publishTime': detail.publishTime,
      'size': detail.size,
      'language': detail.language,
      'isExpunged': detail.isExpunged,
      'torrentCount': detail.torrentCount,
      'torrentPageUrl': detail.torrentPageUrl,
      'archivePageUrl': detail.archivePageUrl,
      'thumbnailsPageCount': detail.thumbnailsPageCount,
      'children': detail.childrenGalleries
              ?.map((dynamic child) => {
                    'url': child.galleryUrl.url,
                    'title': child.title,
                    'updateTime': child.updateTime,
                  })
              .toList() ??
          const <Map<String, dynamic>>[],
      'tags': {
        for (final MapEntry<String, List<GalleryTag>> entry in detail.tags.entries)
          entry.key: entry.value.map((GalleryTag tag) => tag.tagData.key).toList(),
      },
    };
  }

  Map<String, dynamic> _commentToJson(GalleryComment comment) {
    return {
      'id': comment.id,
      'username': comment.username,
      'userId': comment.userId,
      'score': comment.score,
      'scoreDetails': comment.scoreDetails,
      'content': comment.content.outerHtml,
      'time': comment.time,
      'lastEditTime': comment.lastEditTime,
      'fromMe': comment.fromMe,
      'votedUp': comment.votedUp,
      'votedDown': comment.votedDown,
    };
  }

  Map<String, dynamic> _taskToJson(GalleryDownloadInfo info) {
    final GalleryDownloadProgress progress = info.downloadProgress;
    final String galleryDirectory = DownloadPathResolver.computeGalleryDownloadAbsolutePath(info.toGalleryDownloadedData());
    final bool hasCbz = File(CbzService.cbzPathForDirectory(galleryDirectory)).existsSync();
    final String speed = progress.downloadStatus == DownloadStatus.downloading ? info.speedComputer.speed : '';

    return {
      'gid': info.gid,
      'url': info.galleryUrl,
      'title': info.title,
      'category': info.category,
      'pageCount': info.pageCount,
      'downloaded': progress.curCount,
      'total': progress.totalCount,
      'status': progress.downloadStatus.name,
      'group': info.group,
      'priority': info.priority,
      'speed': speed,
      'hasCbz': hasCbz,
      'cover': '/api/library/${info.gid}/cover',
    };
  }

  File? _imageFile(GalleryDownloadInfo info, GalleryImage? image) {
    if (image == null || image.path == null || image.path!.isEmpty) {
      return null;
    }
    final String path = image.path!;
    if (p.isAbsolute(path)) {
      return File(path);
    }
    return File(p.join(pathService.getVisibleDir().path, path));
  }

  Future<void> _serveFile(HttpRequest request, File file, {String? downloadName}) async {
    if (!await file.exists()) {
      return _sendJson(request, HttpStatus.notFound, {'error': 'file not found'});
    }

    request.response.headers.contentType = _contentTypeFor(file.path);
    if (downloadName != null) {
      request.response.headers.set(
        'content-disposition',
        "attachment; filename*=UTF-8''${Uri.encodeComponent(downloadName)}",
      );
    }
    request.response.contentLength = await file.length();
    await request.response.addStream(file.openRead());
    await request.response.close();
  }

  Future<Map<String, dynamic>> _readJsonBody(HttpRequest request) async {
    final String text = await utf8.decoder.bind(request).join();
    if (text.trim().isEmpty) {
      return <String, dynamic>{};
    }
    final dynamic decoded = jsonDecode(text);
    if (decoded is Map<String, dynamic>) {
      return decoded;
    }
    return <String, dynamic>{};
  }

  Future<void> _sendJson(HttpRequest request, int status, Object data) async {
    request.response.statusCode = status;
    request.response.headers.contentType = ContentType.json;
    request.response.write(jsonEncode(data));
    await request.response.close();
  }
}
