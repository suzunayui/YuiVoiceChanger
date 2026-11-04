/* SPDX-License-Identifier: GPL-2.0-or-later */
#include <obs-module.h>
#include <obs-frontend-api.h>

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <memory>

using Source = std::unique_ptr<obs_source_t, decltype(&obs_source_release)>;
using Settings = std::unique_ptr<obs_data_t, decltype(&obs_data_release)>;

static std::unique_ptr<QLocalServer> server;
static constexpr auto filterKind = "yui_preview_delay";
static constexpr auto filterPrefix = u8"YUI映像同期 ";

static QJsonObject settingsObject(obs_source_t *source)
{
 Settings settings(obs_source_get_settings(source), obs_data_release);
 return settings ? QJsonDocument::fromJson(obs_data_get_json(settings.get())).object() : QJsonObject{};
}

static QString text(const char *value)
{
 return QString::fromUtf8(value);
}

static bool desktopSource(obs_source_t *source)
{
 for (uint32_t channel = 1; channel <= 2; ++channel) {
  Source desktop(obs_get_output_source(channel), obs_source_release);
  if (desktop.get() == source)
   return true;
 }
 return false;
}

static bool delayFilter(obs_source_t *filter)
{
 const auto id = text(obs_source_get_id(filter));
 return id == filterKind || id == "gpu_delay";
}

static QJsonObject request(const QString &type, const QJsonObject &data, int &code)
{
 code = 100;
 if (type == "GetVersion") {
  return {{"protocolVersion", 1}, {"availableRequests", QJsonArray{
   "GetInputList", "GetSpecialInputs", "GetInputSettings", "GetInputAudioSyncOffset",
   "GetInputMute", "SetInputMute", "GetSourceFilterDefaultSettings",
   "GetSourceFilterList", "CreateSourceFilter", "RemoveSourceFilter", "SetSourceFilterEnabled"
  }}};
 }
 if (type == "GetInputList") {
  QJsonArray inputs;
  obs_enum_sources([](void *context, obs_source_t *source) {
   if (obs_source_get_type(source) == OBS_SOURCE_TYPE_INPUT)
    static_cast<QJsonArray *>(context)->append(QJsonObject{
     {"inputName", text(obs_source_get_name(source))}, {"inputUuid", text(obs_source_get_uuid(source))},
     {"inputKind", text(obs_source_get_id(source))}, {"unversionedInputKind", text(obs_source_get_unversioned_id(source))}
    });
   return true;
  }, &inputs);
  return {{"inputs", inputs}};
 }
 if (type == "GetSpecialInputs") {
  const char *keys[] = {"desktop1", "desktop2", "mic1", "mic2", "mic3", "mic4"};
  QJsonObject inputs;
  for (uint32_t i = 0; i < 6; ++i) {
   Source source(obs_get_output_source(i + 1), obs_source_release);
   inputs.insert(keys[i], source ? QJsonValue(text(obs_source_get_name(source.get()))) : QJsonValue::Null);
  }
  return inputs;
 }
 if (type == "GetSourceFilterDefaultSettings") {
  if (data.value("filterKind").toString() == filterKind)
   return {{"defaultFilterSettings", QJsonObject{{"delay_ms", 0}}}};
  code = 607;
  return {};
 }

 const bool filterRequest = type == "GetSourceFilterList" || type == "CreateSourceFilter" ||
                            type == "RemoveSourceFilter" || type == "SetSourceFilterEnabled";
 if (!filterRequest && type != "GetInputSettings" && type != "GetInputAudioSyncOffset" &&
     type != "GetInputMute" && type != "SetInputMute") {
  code = 204;
  return {};
 }
 const auto uuid = data.value(filterRequest ? "sourceUuid" : "inputUuid").toString().toUtf8();
 const auto name = data.value(filterRequest ? "sourceName" : "inputName").toString().toUtf8();
 Source source(uuid.isEmpty() ? (name.isEmpty() ? nullptr : obs_get_source_by_name(name.constData()))
                              : obs_get_source_by_uuid(uuid.constData()), obs_source_release);
 if (!source) {
  code = 600;
  return {};
 }
 if (type == "GetInputSettings") {
  const auto settings = settingsObject(source.get());
  return {{"inputKind", text(obs_source_get_id(source.get()))},
          {"unversionedInputKind", text(obs_source_get_unversioned_id(source.get()))},
          {"inputSettings", QJsonObject{{"window", settings.value("window")},
                                        {"spoutsenders", settings.value("spoutsenders")}}}};
 }
 if (type == "GetInputAudioSyncOffset") {
  if (!(obs_source_get_output_flags(source.get()) & OBS_SOURCE_AUDIO)) {
   code = 604;
   return {};
  }
  return {{"inputAudioSyncOffset", double(obs_source_get_sync_offset(source.get()) / 1000000)}};
 }
 if (type == "GetInputMute")
  return {{"inputMuted", obs_source_muted(source.get())}};
 if (type == "SetInputMute") {
  if (!desktopSource(source.get()) || !data.value("inputMuted").isBool()) {
   code = 402;
   return {};
  }
  obs_source_set_muted(source.get(), data.value("inputMuted").toBool());
  obs_frontend_save();
  return {};
 }
 if (type == "GetSourceFilterList") {
  QJsonArray filters;
  obs_source_enum_filters(source.get(), [](obs_source_t *, obs_source_t *filter, void *context) {
   if (!delayFilter(filter))
    return;
   static_cast<QJsonArray *>(context)->append(QJsonObject{
    {"filterName", text(obs_source_get_name(filter))}, {"filterKind", text(obs_source_get_id(filter))},
    {"filterEnabled", obs_source_enabled(filter)}, {"filterSettings", settingsObject(filter)}
   });
  }, &filters);
  return {{"filters", filters}};
 }

 const auto filterName = data.value("filterName").toString();
 if (filterName.isEmpty() || filterName.size() > 256) {
  code = 402;
  return {};
 }
 Source filter(obs_source_get_filter_by_name(source.get(), filterName.toUtf8().constData()), obs_source_release);
 if (type == "CreateSourceFilter") {
  const int delay = data.value("filterSettings").toObject().value("delay_ms").toInt(-1);
  if (!filterName.startsWith(text(filterPrefix)) || data.value("filterKind").toString() != filterKind ||
      delay < 1 || delay > 500) {
   code = 402;
   return {};
  }
  if (filter) {
   code = 601;
   return {};
  }
  Settings settings(obs_data_create(), obs_data_release);
  obs_data_set_int(settings.get(), "delay_ms", delay);
  filter.reset(obs_source_create_private(filterKind, filterName.toUtf8().constData(), settings.get()));
  if (!filter) {
   code = 607;
   return {};
  }
  obs_source_filter_add(source.get(), filter.get());
 } else if (!filter || !delayFilter(filter.get())) {
  code = 600;
  return {};
 } else if (type == "RemoveSourceFilter" && filterName.startsWith(text(filterPrefix))) {
  obs_source_filter_remove(source.get(), filter.get());
 } else if (type == "SetSourceFilterEnabled" && data.value("filterEnabled").isBool()) {
  obs_source_set_enabled(filter.get(), data.value("filterEnabled").toBool());
 } else {
  code = 402;
  return {};
 }
 obs_frontend_save();
 return {};
}

void startYuiControl()
{
 if (server)
  return;
 server = std::make_unique<QLocalServer>();
 server->setSocketOptions(QLocalServer::UserAccessOption);
 QObject::connect(server.get(), &QLocalServer::newConnection, server.get(), [] {
  while (auto *socket = server->nextPendingConnection()) {
   socket->setReadBufferSize(64 * 1024 + 1);
   QObject::connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
   QObject::connect(socket, &QLocalSocket::readyRead, socket, [socket] {
    while (socket->canReadLine()) {
     const auto message = QJsonDocument::fromJson(socket->readLine()).object();
     const auto id = message.value("id").toString();
     if (id.isEmpty() || id.size() > 32) {
      socket->abort();
      return;
     }
     int code = 100;
     const auto response = request(message.value("type").toString(), message.value("data").toObject(), code);
     socket->write(QJsonDocument(QJsonObject{{"id", id}, {"code", code}, {"data", response}})
                   .toJson(QJsonDocument::Compact) + '\n');
    }
    if (socket->bytesAvailable() > 64 * 1024)
     socket->abort();
   });
  }
 });
 if (!server->listen("YuiVoiceChanger-OBS-v1")) {
  blog(LOG_WARNING, "[YuiVoiceChanger] Could not start plugin connection");
  server.reset();
 }
}

void stopYuiControl()
{
 server.reset();
}
