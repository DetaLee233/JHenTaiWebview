import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';
import 'package:jhentai/src/extension/widget_extension.dart';
import 'package:jhentai/src/service/log.dart';
import 'package:jhentai/src/service/web_server/web_server_service.dart';
import 'package:jhentai/src/setting/download_setting.dart';
import 'package:jhentai/src/setting/web_server_setting.dart';
import 'package:jhentai/src/utils/toast_util.dart';
import 'package:url_launcher/url_launcher.dart';

class SettingWebServerPage extends StatefulWidget {
  const SettingWebServerPage({Key? key}) : super(key: key);

  @override
  State<SettingWebServerPage> createState() => _SettingWebServerPageState();
}

class _SettingWebServerPageState extends State<SettingWebServerPage> {
  late final TextEditingController _portController = TextEditingController(text: webServerSetting.port.value.toString());
  late final TextEditingController _tokenController = TextEditingController(text: webServerSetting.token.value);

  @override
  void dispose() {
    _portController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(centerTitle: true, title: Text('webServer'.tr)),
      body: Obx(
        () => ListView(
          padding: const EdgeInsets.only(top: 16),
          children: [
            SwitchListTile(
              title: Text('enableWebServer'.tr),
              subtitle: Text('enableWebServerHint'.tr),
              value: webServerSetting.enable.value,
              onChanged: _setEnable,
            ),
            ListTile(
              title: Text('webServerAddress'.tr),
              subtitle: Text(webServerService.running.value ? webServerService.address : 'webServerStopped'.tr),
              trailing: IconButton(
                icon: const Icon(Icons.open_in_new),
                onPressed: webServerService.running.value ? _openInBrowser : null,
              ),
              onLongPress: webServerService.running.value
                  ? () async {
                      await Clipboard.setData(ClipboardData(text: webServerService.address));
                      toast('Copied', isCenter: false);
                    }
                  : null,
            ),
            SwitchListTile(
              title: Text('webServerAllowRemote'.tr),
              subtitle: Text('webServerAllowRemoteHint'.tr),
              value: webServerSetting.allowRemote.value,
              onChanged: _setAllowRemote,
            ),
            ListTile(
              title: Text('webServerPort'.tr),
              trailing: SizedBox(
                width: 110,
                child: TextField(
                  controller: _portController,
                  textAlign: TextAlign.end,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                  onSubmitted: _setPort,
                ),
              ),
            ),
            ListTile(
              title: Text('webServerToken'.tr),
              subtitle: Text('webServerTokenHint'.tr),
              trailing: SizedBox(
                width: 180,
                child: TextField(
                  controller: _tokenController,
                  textAlign: TextAlign.end,
                  obscureText: true,
                  decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                  onSubmitted: _setToken,
                ),
              ),
            ),
            const Divider(),
            SwitchListTile(
              title: Text('downloadAsCbz'.tr),
              subtitle: Text('downloadAsCbzHint'.tr),
              value: downloadSetting.downloadAsCbz.value,
              onChanged: downloadSetting.saveDownloadAsCbz,
            ),
            if (downloadSetting.downloadAsCbz.value)
              SwitchListTile(
                title: Text('deleteImagesAfterCbz'.tr),
                subtitle: Text('deleteImagesAfterCbzHint'.tr),
                value: downloadSetting.deleteImagesAfterCbz.value,
                onChanged: downloadSetting.saveDeleteImagesAfterCbz,
              ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Text(
                'webServerHint'.tr,
                style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.outline),
              ),
            ),
          ],
        ).withListTileTheme(context),
      ),
    );
  }

  Future<void> _setEnable(bool value) async {
    await webServerSetting.saveEnable(value);

    try {
      if (value) {
        await webServerService.start();
      } else {
        await webServerService.stop();
      }
    } catch (e, stack) {
      log.error('Toggle web server failed', e, stack);
      toast('webServerStartFailed'.tr, isCenter: false);
    }
  }

  Future<void> _setAllowRemote(bool value) async {
    await webServerSetting.saveAllowRemote(value);
    await _restartIfRunning();
  }

  Future<void> _setPort(String value) async {
    final int? port = int.tryParse(value);
    if (port == null || port < 1 || port > 65535) {
      toast('webServerInvalidPort'.tr, isCenter: false);
      _portController.text = webServerSetting.port.value.toString();
      return;
    }

    await webServerSetting.savePort(port);
    await _restartIfRunning();
  }

  Future<void> _setToken(String value) async {
    await webServerSetting.saveToken(value);
  }

  Future<void> _restartIfRunning() async {
    if (!webServerService.running.value) {
      return;
    }
    try {
      await webServerService.restart();
    } catch (e, stack) {
      log.error('Restart web server failed', e, stack);
      toast('webServerStartFailed'.tr, isCenter: false);
    }
  }

  Future<void> _openInBrowser() async {
    final Uri uri = Uri.parse(webServerService.address);
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      toast('webServerOpenFailed'.tr, isCenter: false);
    }
  }
}
