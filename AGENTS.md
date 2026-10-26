# AGENTS.md

Instructions for coding agents working on this repository.

## Project

JHenTai is a Flutter client for E-Hentai / ExHentai. This fork additionally
contains a built-in HTTP server and a browser WebUI.

See `CLAUDE.md` for the broader Flutter/GetX architecture. This file focuses on
the web server, WebUI, and tasks that agents commonly need to perform.

## Build and verification

```bash
flutter pub get
dart run build_runner build          # after changing @DriftDatabase tables/queries
flutter analyze
flutter test
flutter build linux --release -t lib/src/main.dart
```

CI currently uses Flutter `3.44.8` (see `.github/workflows/build_publish.yml`).

`intl` is pinned to `0.20.2` for that Flutter version. Flutter 3.47+ requires
`intl ^0.20.3`; if you temporarily bump it to build locally, do not commit the
`intl`, `pubspec.lock`, or `analysis_options.yaml` changes unless the whole
project is upgraded intentionally.

Run code generation only when database tables/queries change. Most changes do
not require it.

## Web server / WebUI map

Dart:

- `lib/src/service/web_server/web_server_service.dart` - HTTP server, routing,
  JSON API, image proxy, online/archive/local reading helpers.
- `lib/src/service/web_server/cbz_service.dart` - CBZ creation in an isolate,
  direct-first image fetch support is in the web server.
- `lib/src/setting/web_server_setting.dart` - enable/port/token settings;
  enabled by default.
- `lib/src/pages/setting/advanced/web_server/setting_web_server_page.dart` -
  Flutter settings UI.
- `lib/src/setting/download_setting.dart` - `downloadAsCbz` and
  `deleteImagesAfterCbz`.
- `lib/src/service/gallery_download/gallery_download_service.dart` - triggers
  CBZ packing after a gallery finishes downloading.

Web assets:

- `assets/webui/index.html`
- `assets/webui/style.css`
- `assets/webui/app.js`
- `assets/webui/MaterialIcons-Regular.otf` + license (copied from the Flutter
  SDK; do not replace with a CDN dependency).

The WebUI is intentionally plain HTML/CSS/JavaScript: no npm, no bundler, no
framework. Keep it that way unless there is a strong reason to add a build step.

Assets are loaded disk-first on desktop
(`<exe>/data/flutter_assets/assets/webui/...`) and fall back to `rootBundle`.
This means a built desktop bundle can be updated by copying files into
`build/linux/x64/release/bundle/data/flutter_assets/assets/webui/` and
restarting the app, without a Flutter rebuild.

## Server architecture

- `WebServerService` is a global lifecycle bean (`webServerService`) registered
  in `lib/src/main.dart`.
- It reuses `ehRequest`, so browser requests inherit the app's E-Hentai cookies,
  system/HTTP/SOCKS proxy and domain-fronting configuration. There is no second
  login flow; if the app is not logged in, favorites/watched/rating/comments
  return `403`.
- Default port is `8686`; binds `0.0.0.0` when `allowRemote` is true, otherwise
  `127.0.0.1`.
- Token authentication is optional. When `webServerSetting.token` is non-empty,
  accept `?token=`, `X-Auth-Token`, `Authorization: Bearer`, or the
  `jh_web_token` cookie. Image `<img>` URLs must include the token because
  browsers cannot add headers there.
- Requests retry twice with a longer connect timeout. Do not add unbounded
  retries; the WebUI waits on the HTTP request and must not spin forever.

## API overview

Core:

- `GET /api/status`
- `GET /api/galleries?type=home|search|popular|favorite|watched`
- `GET /api/ranklist?type=day|month|year|allTime&page=0`
- `GET /api/history`, `DELETE /api/history?gid=`
- `GET /api/gallery?url=<gallery url>`
- `GET /api/read/pages?url=&index=`
- `GET /api/read/image?href=`
- `GET /api/progress?gid=`, `POST /api/progress`

Detail actions:

- `POST /api/download`
- `POST /api/favorite`
- `POST /api/rating`
- `POST /api/comment`
- `GET /api/torrents?url=`
- `GET /api/stats?url=`
- `GET /api/archive?archiveUrl=`
- `POST /api/archive/download`
- `GET|POST /api/hh`

Downloads/library:

- `GET /api/tasks`, `POST /api/tasks/<gid>/pause|resume|delete`
- `GET /api/archive-tasks`,
  `POST /api/archive-tasks/<gid>/pause|resume|cancel|delete`
- `GET /api/library`, `GET /api/library/<gid>`,
  `GET /api/library/<gid>/images`,
  `GET /api/library/<gid>/file/<serial>`,
  `GET /api/library/<gid>/cover`,
  `GET /api/library/<gid>/cbz`
- `GET /api/archive-library/<gid>/images`,
  `GET /api/archive-library/<gid>/file/<serial>`
- `GET /api/local-galleries`,
  `GET /api/local-galleries/images?path=`,
  `GET /api/local-galleries/file?path=&index=`

Settings:

- `GET|POST /api/appearance` - theme mode/colors/locale/site
- `GET|POST /api/network` - proxy type/address/timeouts/domain fronting
- `GET|POST /api/settings` - CBZ settings and web server port/token
- `GET /api/filters` - categories, favorite names, groups, user info
- `GET /api/proxy?url=` - image proxy, restricted to EH image hosts

## Behaviour notes

- Image proxy tries a direct `HttpClient` first, then falls back to the app's
  proxy. `ehgt.org` is often reachable directly even when e-hentai needs a
  proxy; keep this fallback.
- CBZ files are stored next to the gallery directory as
  `<gid> - <title>.cbz`. Packing runs in an isolate and stores entries without
  deflate. `deleteImagesAfterCbz` is destructive and opt-in.
- Auto-packing after a download is triggered from
  `_updateProgressAfterImageDownloaded`. Web requests can also mark a gallery
  for CBZ packing.
- The reader supports online, app-downloaded, archive-unpacked and local-folder
  images, in continuous-scroll and single-page modes.
- Reading progress is stored by the app (`readProgressService`), so WebUI and
  App stay in sync.

## UI conventions

- Match the existing Flutter desktop layout: left icon rail, centre gallery
  pane, right detail/reader pane. On narrow screens use the bottom navigation.
- Use the Material Icons font and category/tag colours already present in the
  CSS. Do not introduce emoji icons or external icon CDNs.
- Keep the WebUI self-contained and LAN-oriented.
- Escape user/site-provided strings. Comment HTML must pass through
  `sanitizeHtml` in `app.js`.
- Avoid blocking spinners: show an error message with a retry path when a
  request fails or times out.

## Git

- Do not commit build artefacts, `.dart_tool/`, downloaded media, tokens, or
  local configuration.
- Do not commit or push unless explicitly requested.
- Do not put GitHub tokens in the repository, git config, or committed scripts.
