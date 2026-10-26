import 'dart:convert';

import 'package:get/get.dart';
import 'package:jhentai/src/enum/config_enum.dart';
import 'package:jhentai/src/service/jh_service.dart';

WebServerSetting webServerSetting = WebServerSetting();

/// Configuration for the built-in HTTP server that exposes the app's E-Hentai
/// session, download queue and local library to a browser.
class WebServerSetting with JHLifeCircleBeanWithConfigStorage implements JHLifeCircleBean {
  static const int defaultPort = 8686;

  RxBool enable = true.obs;
  RxBool allowRemote = true.obs;
  RxInt port = defaultPort.obs;
  RxString token = ''.obs;

  @override
  ConfigEnum get configEnum => ConfigEnum.webServerSetting;

  @override
  void applyBeanConfig(String configString) {
    Map map = jsonDecode(configString);

    enable.value = map['enable'] ?? enable.value;
    allowRemote.value = map['allowRemote'] ?? allowRemote.value;
    port.value = map['port'] ?? port.value;
    token.value = map['token'] ?? token.value;

    if (port.value < 1 || port.value > 65535) {
      port.value = defaultPort;
    }
  }

  @override
  String toConfigString() {
    return jsonEncode({
      'enable': enable.value,
      'allowRemote': allowRemote.value,
      'port': port.value,
      'token': token.value,
    });
  }

  @override
  Future<void> doInitBean() async {}

  @override
  void doAfterBeanReady() {}

  Future<void> saveEnable(bool value) async {
    enable.value = value;
    await saveBeanConfig();
  }

  Future<void> saveAllowRemote(bool value) async {
    allowRemote.value = value;
    await saveBeanConfig();
  }

  Future<void> savePort(int value) async {
    if (value < 1 || value > 65535) {
      return;
    }
    port.value = value;
    await saveBeanConfig();
  }

  Future<void> saveToken(String value) async {
    token.value = value.trim();
    await saveBeanConfig();
  }

}
