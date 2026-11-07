#include "ruview_csi.h"

#include <cstring>

#include "esphome/components/wifi/wifi_component.h"
#include "esphome/core/hal.h"
#include "esphome/core/log.h"

#include <esp_heap_caps.h>
#include <esp_netif.h>
#include <esp_timer.h>
#include <lwip/inet.h>
#include <lwip/ip_addr.h>
#include <lwip/sockets.h>

namespace esphome {
namespace ruview_csi {

static const char *const TAG = "ruview_csi";

static uint32_t channel_to_mhz(uint8_t channel) {
  if (channel >= 1 && channel <= 13)
    return 2412 + (channel - 1) * 5;
  if (channel == 14)
    return 2484;
  if (channel >= 36 && channel <= 177)
    return 5000 + channel * 5;
  return 0;
}

void RuViewCsi::setup() {
  // Capture only the long training fields a classic ESP32 reports for frames
  // addressed to this station. Wi-Fi mode, channel and promiscuous settings are
  // left exactly as ESPHome configured them.
  wifi_csi_config_t cfg{};
  cfg.lltf_en = true;
  cfg.htltf_en = true;
  cfg.stbc_htltf2_en = false;
  cfg.ltf_merge_en = true;
  cfg.channel_filter_en = false;
  cfg.manu_scale = false;
  cfg.shift = 0;

  esp_err_t err = esp_wifi_set_csi_config(&cfg);
  if (err == ESP_OK)
    err = esp_wifi_set_csi_rx_cb(&RuViewCsi::csi_callback_, this);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "CSI setup failed: %s", esp_err_to_name(err));
    this->mark_failed();
    return;
  }
  this->csi_registered_ = true;
}

void RuViewCsi::set_enabled(bool enabled) {
  this->enabled_.store(enabled);
  ESP_LOGI(TAG, "CSI streaming %s", enabled ? "enabled" : "disabled");
}

void RuViewCsi::csi_callback_(void *ctx, wifi_csi_info_t *info) {
  if (ctx != nullptr && info != nullptr)
    static_cast<RuViewCsi *>(ctx)->on_csi_(info);
}

// Runs in the Wi-Fi task: copy into the ring and return, never block or allocate.
void RuViewCsi::on_csi_(const wifi_csi_info_t *info) {
  if (!this->enabled_.load() || this->paused_low_heap_.load() || info->buf == nullptr || info->len <= 0)
    return;
  size_t iq_len = static_cast<size_t>(info->len);
  if (iq_len > CSI_MAX_IQ) {
    this->frames_dropped_.fetch_add(1);
    return;
  }

  int64_t now = esp_timer_get_time();
  portENTER_CRITICAL(&this->lock_);
  if (now - this->last_accept_us_ < static_cast<int64_t>(this->min_interval_us_)) {
    portEXIT_CRITICAL(&this->lock_);
    return;
  }
  if (this->count_ >= CSI_RING_SLOTS) {
    portEXIT_CRITICAL(&this->lock_);
    this->frames_dropped_.fetch_add(1);
    return;
  }
  this->last_accept_us_ = now;
  size_t idx = (this->head_ + this->count_) % CSI_RING_SLOTS;
  uint8_t *buf = this->slots_[idx];

  uint32_t magic = CSI_MAGIC;
  uint16_t n_sub = static_cast<uint16_t>(iq_len / 2);  // one antenna
  uint32_t freq = channel_to_mhz(info->rx_ctrl.channel);
  uint32_t seq = this->sequence_++;
  memcpy(&buf[0], &magic, 4);
  buf[4] = this->node_id_;
  buf[5] = 1;
  memcpy(&buf[6], &n_sub, 2);
  memcpy(&buf[8], &freq, 4);
  memcpy(&buf[12], &seq, 4);
  buf[16] = static_cast<uint8_t>(static_cast<int8_t>(info->rx_ctrl.rssi));
  buf[17] = static_cast<uint8_t>(static_cast<int8_t>(info->rx_ctrl.noise_floor));
  buf[18] = 0;  // HT/legacy PPDU bucket (ADR-110)
  uint8_t flags = 0;
  if (info->rx_ctrl.cwb)
    flags |= 0x1;
  if (info->rx_ctrl.stbc)
    flags |= 1 << 2;
  memcpy(&buf[CSI_HEADER_SIZE], info->buf, iq_len);
  if (info->first_word_invalid) {
    memset(&buf[CSI_HEADER_SIZE], 0, iq_len < 4 ? iq_len : 4);
    flags |= CSI_FLAG_FIRST_WORD_SANITIZED;
  }
  buf[19] = flags;
  this->slot_len_[idx] = static_cast<uint16_t>(CSI_HEADER_SIZE + iq_len);
  this->count_++;
  portEXIT_CRITICAL(&this->lock_);
}

bool RuViewCsi::open_socket_() {
  if (this->sock_ >= 0)
    return true;
  this->sock_ = lwip_socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (this->sock_ < 0) {
    ESP_LOGW(TAG, "socket() failed");
    return false;
  }
  int flags = lwip_fcntl(this->sock_, F_GETFL, 0);
  lwip_fcntl(this->sock_, F_SETFL, flags | O_NONBLOCK);
  return true;
}

void RuViewCsi::start_self_ping_() {
  if (this->ping_ != nullptr || this->self_ping_hz_ == 0)
    return;
  esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  esp_netif_ip_info_t ip{};
  if (sta == nullptr || esp_netif_get_ip_info(sta, &ip) != ESP_OK || ip.gw.addr == 0)
    return;

  esp_ping_config_t cfg = ESP_PING_DEFAULT_CONFIG();
  cfg.target_addr.type = IPADDR_TYPE_V4;
  cfg.target_addr.u_addr.ip4.addr = ip.gw.addr;
  cfg.count = ESP_PING_COUNT_INFINITE;
  cfg.interval_ms = 1000 / this->self_ping_hz_;
  cfg.timeout_ms = cfg.interval_ms;
  cfg.data_size = 1;
  cfg.task_stack_size = 3072;
  cfg.task_prio = 1;  // below the BLE host and Wi-Fi tasks

  esp_ping_callbacks_t cbs{};
  if (esp_ping_new_session(&cfg, &cbs, &this->ping_) == ESP_OK && this->ping_ != nullptr) {
    esp_ping_start(this->ping_);
    ESP_LOGI(TAG, "Gateway ping started at %u Hz", (unsigned) this->self_ping_hz_);
  } else {
    this->ping_ = nullptr;
  }
}

void RuViewCsi::stop_self_ping_() {
  if (this->ping_ == nullptr)
    return;
  esp_ping_stop(this->ping_);
  esp_ping_delete_session(this->ping_);
  this->ping_ = nullptr;
}

void RuViewCsi::loop() {
  if (!this->csi_registered_)
    return;

  uint32_t now_ms = millis();
  if (now_ms - this->last_heap_check_ms_ > 1000) {
    this->last_heap_check_ms_ = now_ms;
    bool low = heap_caps_get_free_size(MALLOC_CAP_8BIT) < this->min_free_heap_;
    if (low != this->paused_low_heap_.load()) {
      this->paused_low_heap_.store(low);
      ESP_LOGW(TAG, "CSI %s: free heap %u", low ? "paused" : "resumed",
               (unsigned) heap_caps_get_free_size(MALLOC_CAP_8BIT));
    }
  }

  bool want = this->enabled_.load() && !this->paused_low_heap_.load() && wifi::global_wifi_component != nullptr &&
              wifi::global_wifi_component->is_connected();
  if (want != this->csi_running_) {
    esp_wifi_set_csi(want);
    this->csi_running_ = want;
    if (want) {
      this->start_self_ping_();
    } else {
      this->stop_self_ping_();
    }
  } else if (want && this->ping_ == nullptr) {
    this->start_self_ping_();  // gateway may not have been known yet
  }
  if (!want || !this->open_socket_())
    return;

  sockaddr_in dst{};
  dst.sin_family = AF_INET;
  dst.sin_port = htons(this->target_port_);
  dst.sin_addr.s_addr = inet_addr(this->target_host_.c_str());

  uint8_t frame[CSI_MAX_FRAME];
  for (;;) {
    uint16_t len = 0;
    portENTER_CRITICAL(&this->lock_);
    if (this->count_ > 0) {
      len = this->slot_len_[this->head_];
      memcpy(frame, this->slots_[this->head_], len);
      this->head_ = (this->head_ + 1) % CSI_RING_SLOTS;
      this->count_--;
    }
    portEXIT_CRITICAL(&this->lock_);
    if (len == 0)
      break;
    if (lwip_sendto(this->sock_, frame, len, 0, reinterpret_cast<sockaddr *>(&dst), sizeof(dst)) == len) {
      this->frames_sent_++;
    } else {
      this->frames_dropped_.fetch_add(1);
    }
  }
}

void RuViewCsi::dump_config() {
  ESP_LOGCONFIG(TAG, "RuView CSI:");
  ESP_LOGCONFIG(TAG, "  Target: %s:%u", this->target_host_.c_str(), this->target_port_);
  ESP_LOGCONFIG(TAG, "  Node ID: %u", this->node_id_);
  ESP_LOGCONFIG(TAG, "  Max rate: %u Hz", (unsigned) (1000000 / this->min_interval_us_));
  ESP_LOGCONFIG(TAG, "  Gateway ping: %u Hz", (unsigned) this->self_ping_hz_);
  ESP_LOGCONFIG(TAG, "  Min free heap: %u", (unsigned) this->min_free_heap_);
}

}  // namespace ruview_csi
}  // namespace esphome
