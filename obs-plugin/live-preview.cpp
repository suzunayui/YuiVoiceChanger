/* SPDX-License-Identifier: GPL-2.0-or-later */
#include <obs-module.h>
#include <obs-frontend-api.h>

#include <QAction>
#include <QLayout>
#include <QPaintEvent>
#include <QPointer>
#include <QTimer>
#include <QWidget>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <memory>
#include <vector>

OBS_DECLARE_MODULE()

extern "C" {
extern struct obs_source_info gpu_delay_filter;
void yui_set_live_preview(bool enabled);
}

using Scene = std::unique_ptr<obs_scene_t, decltype(&obs_scene_release)>;
using Item = std::unique_ptr<obs_sceneitem_t, decltype(&obs_sceneitem_release)>;
using Source = std::unique_ptr<obs_source_t, decltype(&obs_source_release)>;

static Scene copyScene(obs_scene_t *scene);

static void copyNestedScenes(obs_scene_t *scene)
{
 std::vector<Item> items;
 obs_scene_enum_items(scene, [](obs_scene_t *, obs_sceneitem_t *item, void *data) {
  obs_sceneitem_addref(item);
  static_cast<std::vector<Item> *>(data)->emplace_back(item, obs_sceneitem_release);
  return true;
 }, &items);
 for (const auto &item : items) {
  auto *nested = obs_group_or_scene_from_source(obs_sceneitem_get_source(item.get()));
  if (!nested)
   continue;
  if (obs_sceneitem_is_group(item.get())) {
   // Private reference duplication already gives groups their own scene items.
   copyNestedScenes(nested);
   continue;
  }
  auto copy = copyScene(nested);
  auto *replacement = copy ? obs_scene_add(scene, obs_scene_get_source(copy.get())) : nullptr;
  if (!replacement)
   continue;
  obs_transform_info transform{};
  obs_sceneitem_crop crop{};
  obs_sceneitem_get_info2(item.get(), &transform);
  obs_sceneitem_get_crop(item.get(), &crop);
  obs_sceneitem_set_info2(replacement, &transform);
  obs_sceneitem_set_crop(replacement, &crop);
  obs_sceneitem_set_scale_filter(replacement, obs_sceneitem_get_scale_filter(item.get()));
  obs_sceneitem_set_blending_method(replacement, obs_sceneitem_get_blending_method(item.get()));
  obs_sceneitem_set_blending_mode(replacement, obs_sceneitem_get_blending_mode(item.get()));
  obs_sceneitem_set_visible(replacement, obs_sceneitem_visible(item.get()));
  obs_sceneitem_set_order_position(replacement, obs_sceneitem_get_order_position(item.get()));
  obs_sceneitem_remove(item.get());
 }
}

static Scene copyScene(obs_scene_t *scene)
{
 Scene copy(scene ? obs_scene_duplicate(scene, "YuiVoiceChanger", OBS_SCENE_DUP_PRIVATE_REFS) : nullptr,
            obs_scene_release);
 if (copy)
  copyNestedScenes(copy.get());
 return copy;
}

class LivePreview final : public QWidget {
public:
 explicit LivePreview(QWidget *parent) : QWidget(parent)
 {
  setObjectName(QStringLiteral("yuiLivePreview"));
  setAccessibleName(QStringLiteral("YuiVoiceChanger"));
  setAttribute(Qt::WA_NativeWindow);
  setAttribute(Qt::WA_PaintOnScreen);
  setAttribute(Qt::WA_NoSystemBackground);
  setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
  connect(&refresh, &QTimer::timeout, this, [this] {
   if (dirty.exchange(false))
    rebuild();
  });
  refresh.start(100);
 }

 ~LivePreview() override
 {
  if (display) {
   obs_display_remove_draw_callback(display, draw, this);
   obs_display_destroy(display);
  }
  clearWatches();
 }

 void setScene(obs_source_t *source)
 {
  original.reset(source ? obs_source_get_ref(source) : nullptr);
  dirty = false;
  rebuild();
 }

protected:
 QPaintEngine *paintEngine() const override { return nullptr; }

 void paintEvent(QPaintEvent *) override
 {
  const QSize pixels = size() * devicePixelRatioF();
  if (display || pixels.isEmpty())
   return;
  gs_init_data info{};
  info.window.hwnd = reinterpret_cast<void *>(winId());
  info.cx = pixels.width();
  info.cy = pixels.height();
  info.format = GS_BGRA;
  info.zsformat = GS_ZS_NONE;
  display = obs_display_create(&info, 0x202020);
  if (display)
   obs_display_add_draw_callback(display, draw, this);
 }

 void resizeEvent(QResizeEvent *) override
 {
  const QSize pixels = size() * devicePixelRatioF();
  if (display && !pixels.isEmpty())
   obs_display_resize(display, pixels.width(), pixels.height());
 }

private:
 static constexpr const char *signalsToWatch[] = {
  "item_add", "item_remove", "item_transform", "item_visible", "reorder",
  "filter_add", "filter_remove", "reorder_filters"
 };

 static void sceneChanged(void *data, calldata_t *)
 {
  static_cast<LivePreview *>(data)->dirty = true;
 }

 void watch(obs_source_t *source)
 {
  auto *scene = obs_group_or_scene_from_source(source);
  if (!scene || std::any_of(watched.begin(), watched.end(),
                           [source](const auto &entry) { return entry.get() == source; }))
   return;
  watched.emplace_back(obs_source_get_ref(source), obs_source_release);
  auto *handler = obs_source_get_signal_handler(source);
  for (const char *name : signalsToWatch)
   signal_handler_connect(handler, name, sceneChanged, this);
  obs_scene_enum_items(scene, [](obs_scene_t *, obs_sceneitem_t *item, void *data) {
   static_cast<LivePreview *>(data)->watch(obs_sceneitem_get_source(item));
   return true;
  }, this);
 }

 void clearWatches()
 {
  for (const auto &source : watched)
   for (const char *name : signalsToWatch)
    signal_handler_disconnect(obs_source_get_signal_handler(source.get()), name, sceneChanged, this);
  watched.clear();
 }

 void rebuild()
 {
  clearWatches();
  if (original)
   watch(original.get());
  // Separate scene-item render targets keep OBS's per-frame texture cache isolated.
  auto copy = copyScene(original ? obs_scene_from_source(original.get()) : nullptr);
  std::lock_guard lock(sceneMutex);
  scene.swap(copy);
 }

 static void draw(void *data, uint32_t width, uint32_t height)
 {
  auto *preview = static_cast<LivePreview *>(data);
  Scene scene(nullptr, obs_scene_release);
  {
   std::lock_guard lock(preview->sceneMutex);
   if (preview->scene)
    scene.reset(obs_scene_get_ref(preview->scene.get()));
  }
  if (!scene)
   return;
  auto *source = obs_scene_get_source(scene.get());
  const uint32_t sourceWidth = obs_source_get_width(source);
  const uint32_t sourceHeight = obs_source_get_height(source);
  if (sourceWidth && sourceHeight) {
   const double scale = std::min(double(width) / sourceWidth, double(height) / sourceHeight);
   const int fittedWidth = int(std::round(sourceWidth * scale));
   const int fittedHeight = int(std::round(sourceHeight * scale));
   gs_viewport_push();
   gs_projection_push();
   gs_set_viewport((int(width) - fittedWidth) / 2, (int(height) - fittedHeight) / 2,
                   fittedWidth, fittedHeight);
   gs_ortho(0.f, float(sourceWidth), 0.f, float(sourceHeight), -100.f, 100.f);
   yui_set_live_preview(true);
   obs_source_video_render(source);
   yui_set_live_preview(false);
   gs_projection_pop();
   gs_viewport_pop();
  }
 }

 obs_display_t *display = nullptr;
 std::mutex sceneMutex;
 Scene scene{nullptr, obs_scene_release};
 Source original{nullptr, obs_source_release};
 std::vector<Source> watched;
 std::atomic_bool dirty{false};
 QTimer refresh;
};

static QPointer<QAction> action;
static QPointer<QWidget> standardPreview;
static QPointer<QWidget> zoomControls;
static QPointer<LivePreview> livePreview;
static bool restoreDisabledPreview = false;

static void updateScene()
{
 if (!livePreview)
  return;
 obs_source_t *source = obs_frontend_get_current_scene();
 livePreview->setScene(source);
 obs_source_release(source);
}

static void stopPreview()
{
 if (!livePreview)
  return;
 if (standardPreview) {
  auto *layout = standardPreview->parentWidget()->layout();
  delete layout->replaceWidget(livePreview, standardPreview);
  standardPreview->show();
 }
 delete livePreview.data();
 if (zoomControls)
  zoomControls->show();
 zoomControls.clear();
 standardPreview.clear();
 if (restoreDisabledPreview)
  obs_frontend_set_preview_enabled(false);
 if (action)
  action->setChecked(false);
}

static void togglePreview()
{
 if (livePreview) {
  stopPreview();
  return;
 }
 auto *window = static_cast<QWidget *>(obs_frontend_get_main_window());
 auto *original = window ? window->findChild<QWidget *>(QStringLiteral("preview")) : nullptr;
 auto *layout = original ? original->parentWidget()->layout() : nullptr;
 if (!layout || obs_frontend_preview_program_mode_active()) {
  if (action)
   action->setChecked(false);
  return;
 }
 auto *replacement = new LivePreview(original->parentWidget());
 std::unique_ptr<QLayoutItem> oldItem(layout->replaceWidget(original, replacement));
 if (!oldItem) {
  delete replacement;
  if (action)
   action->setChecked(false);
  return;
 }
 restoreDisabledPreview = !obs_frontend_preview_enabled();
 obs_frontend_set_preview_enabled(true);
 standardPreview = original;
 livePreview = replacement;
 auto *controls = original->parentWidget()->findChild<QWidget *>(QStringLiteral("previewXContainer"));
 if (controls && !controls->isHidden()) {
  zoomControls = controls;
  controls->hide();
 }
 updateScene();
 original->hide();
 livePreview->show();
 if (action)
  action->setChecked(true);
}

static void frontendEvent(enum obs_frontend_event event, void *)
{
 switch (event) {
 case OBS_FRONTEND_EVENT_SCENE_CHANGED:
 case OBS_FRONTEND_EVENT_SCENE_COLLECTION_CHANGED:
  updateScene();
  break;
 case OBS_FRONTEND_EVENT_SCENE_COLLECTION_CHANGING:
  if (livePreview)
   livePreview->setScene(nullptr);
  break;
 case OBS_FRONTEND_EVENT_STUDIO_MODE_ENABLED:
 case OBS_FRONTEND_EVENT_EXIT:
  stopPreview();
  break;
 default:
  break;
 }
}

MODULE_EXPORT const char *obs_module_name(void) { return "YuiVoiceChanger"; }

bool obs_module_load(void)
{
 obs_register_source(&gpu_delay_filter);
 action = static_cast<QAction *>(obs_frontend_add_tools_menu_qaction("YuiVoiceChanger"));
 if (action) {
  action->setCheckable(true);
  QObject::connect(action.data(), &QAction::triggered, [](bool) { togglePreview(); });
 }
 obs_frontend_add_event_callback(frontendEvent, nullptr);
 return true;
}

void obs_module_unload(void)
{
 obs_frontend_remove_event_callback(frontendEvent, nullptr);
 stopPreview();
 delete action.data();
}
