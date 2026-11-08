#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string>

#include "esphome/core/component.h"

#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>
#include <ping/ping_sock.h>

namespace esphome {
namespace ruview_csi {

// ADR-018 raw CSI frame: 20-byte header followed by I/Q pairs.
static constexpr uint32_t CSI_MAGIC = 0xC5110001;
static constexpr size_t CSI_HEADER_SIZE = 20;
// L-LTF + HT-LTF on a classic ESP32 is at most 384 bytes of I/Q data.
static constexpr size_t CSI_MAX_IQ = 384;
static constexpr size_t CSI_MAX_FRAME = CSI_HEADER_SIZE + CSI_MAX_IQ;
static constexpr size_t CSI_RING_SLOTS = 4;
// ADR-018 byte 19 bit 5: first four I/Q bytes zeroed (hardware artefact).
static constexpr uint8_t CSI_FLAG_FIRST_WORD_SANITIZED = 1 << 5;

class RuViewCsi : public Component {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  void set_target(const std::string &host, uint16_t port) {
    this->target_host_ = host;
    this->target_port_ = port;
  }
  void set_node_id(uint8_t node_id) { this->node_id_ = node_id; }
  void set_max_rate_hz(uint32_t hz) { this->min_interval_us_ = 1000000 / (hz ? hz : 1); }
  void set_self_ping_hz(uint32_t hz) { this->self_ping_hz_ = hz; }
  void set_min_free_heap(uint32_t bytes) { this->min_free_heap_ = bytes; }

  // Runtime switch: turning CSI off stops capture and pings, BLE is untouched.
  void set_enabled(bool enabled);
  bool is_enabled() const { return this->enabled_.load(); }

  // Diagnostics for template sensors.
  uint32_t get_frames_sent() const { return this->frames_sent_; }
  uint32_t get_frames_dropped() const { return this->frames_dropped_.load(); }
  bool is_paused_low_heap() const { return this->paused_low_heap_.load(); }

 protected:
  static void csi_callback_(void *ctx, wifi_csi_info_t *info);
  void on_csi_(const wifi_csi_info_t *info);
  bool open_socket_();
  void start_self_ping_();
  void stop_self_ping_();

  std::string target_host_;
  uint16_t target_port_{5005};
  uint8_t node_id_{1};
  uint32_t min_interval_us_{50000};
  uint32_t self_ping_hz_{10};
  uint32_t min_free_heap_{40000};

  std::atomic<bool> enabled_{true};
  std::atomic<bool> paused_low_heap_{false};
  bool csi_registered_{false};
  bool csi_running_{false};
  int sock_{-1};
  esp_ping_handle_t ping_{nullptr};
  bool ping_running_{false};
  uint32_t last_heap_check_ms_{0};

  // Ring buffer filled from the Wi-Fi task, drained in loop().
  portMUX_TYPE lock_ = portMUX_INITIALIZER_UNLOCKED;
  uint8_t slots_[CSI_RING_SLOTS][CSI_MAX_FRAME];
  uint16_t slot_len_[CSI_RING_SLOTS]{};
  size_t head_{0};
  size_t count_{0};
  int64_t last_accept_us_{0};
  uint32_t sequence_{0};

  uint32_t frames_sent_{0};
  std::atomic<uint32_t> frames_dropped_{0};
};

}  // namespace ruview_csi
}  // namespace esphome
