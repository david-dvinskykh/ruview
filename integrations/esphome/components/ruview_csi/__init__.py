"""RuView CSI streamer for ESPHome (ESP-IDF, ESP32 family).

Captures Wi-Fi Channel State Information on a node that keeps running its
normal ESPHome workload (for example `bluetooth_proxy`) and streams it to the
RuView sensing server as ADR-018 raw CSI frames (magic 0xC511_0001) over UDP.

The component never changes the Wi-Fi mode, channel or promiscuous state that
ESPHome manages, so the station connection and BLE coexistence stay as they are.
"""

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components.esp32 import add_idf_sdkconfig_option
from esphome.const import CONF_ID, CONF_PORT

CODEOWNERS = ["@david-dvinskykh"]
DEPENDENCIES = ["wifi", "esp32"]

CONF_TARGET_HOST = "target_host"
CONF_NODE_ID = "node_id"
CONF_MAX_RATE_HZ = "max_rate_hz"
CONF_SELF_PING_HZ = "self_ping_hz"
CONF_MIN_FREE_HEAP = "min_free_heap"
CONF_ENABLED = "enabled"

ruview_csi_ns = cg.esphome_ns.namespace("ruview_csi")
RuViewCsi = ruview_csi_ns.class_("RuViewCsi", cg.Component)


CONFIG_SCHEMA = cv.All(
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(RuViewCsi),
            cv.Required(CONF_TARGET_HOST): cv.ipv4address,
            cv.Optional(CONF_PORT, default=5005): cv.port,
            # 0 is used by the sensing server for aggregate/synthetic frames.
            cv.Required(CONF_NODE_ID): cv.int_range(min=1, max=255),
            cv.Optional(CONF_MAX_RATE_HZ, default=20): cv.int_range(min=1, max=50),
            # Gateway pings guarantee unicast OFDM frames to measure; 0 disables.
            cv.Optional(CONF_SELF_PING_HZ, default=10): cv.int_range(min=0, max=50),
            # CSI pauses itself below this free heap so BLE proxy keeps its memory.
            cv.Optional(CONF_MIN_FREE_HEAP, default=40000): cv.int_range(
                min=10000, max=200000
            ),
            cv.Optional(CONF_ENABLED, default=True): cv.boolean,
        }
    ).extend(cv.COMPONENT_SCHEMA),
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    cg.add(var.set_target(str(config[CONF_TARGET_HOST]), config[CONF_PORT]))
    cg.add(var.set_node_id(config[CONF_NODE_ID]))
    cg.add(var.set_max_rate_hz(config[CONF_MAX_RATE_HZ]))
    cg.add(var.set_self_ping_hz(config[CONF_SELF_PING_HZ]))
    cg.add(var.set_min_free_heap(config[CONF_MIN_FREE_HEAP]))
    cg.add(var.set_enabled(config[CONF_ENABLED]))

    add_idf_sdkconfig_option("CONFIG_ESP_WIFI_CSI_ENABLED", True)
