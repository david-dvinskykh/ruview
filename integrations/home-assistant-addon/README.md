# RuView on Home Assistant with ESPHome nodes

This directory holds two pieces that let ESP32 boards which already run ESPHome
(for example as Bluetooth proxies) also act as RuView CSI sensors:

| Piece | Path | What it does |
|---|---|---|
| ESPHome component `ruview_csi` | `../esphome/components/ruview_csi` | Captures Wi-Fi CSI and streams ADR-018 frames (magic `0xC511_0001`) over UDP |
| Home Assistant add-on `ruview` | `ruview/` | Runs the published `ruvnet/wifi-densepose` sensing server and publishes per-node entities through MQTT discovery (ADR-115) |

## Coexistence with `bluetooth_proxy`

`ruview_csi` never touches the Wi-Fi mode, channel or promiscuous state that
ESPHome owns, so the station link and the BLE scanner keep their settings.
To protect BLE tracking it:

- copies CSI in the Wi-Fi callback into a fixed four-slot ring (no allocation)
  and sends from `loop()` with a non-blocking UDP socket;
- caps capture at `max_rate_hz` (default 20 Hz) and the gateway ping that
  provides unicast OFDM frames at `self_ping_hz` (default 10 Hz, priority 1);
- pauses itself while free heap is below `min_free_heap` (default 40 kB);
- exposes `set_enabled()` so a template switch can stop CSI at runtime
  without reflashing.

CSI only covers frames the station receives (its own traffic and its AP's
broadcasts). Promiscuous multi-node capture from the native RuView firmware
is not available in this mode. Sensing quality on this path is not measured.

## ESPHome configuration

```yaml
external_components:
  - source:
      type: local
      path: components          # copy of integrations/esphome/components

ruview_csi:
  id: ruview
  target_host: 192.168.1.1      # Home Assistant host running the add-on
  node_id: ${ruview_node_id}    # 1..255, unique per board
  max_rate_hz: 20
  self_ping_hz: 10

esp32:
  framework:
    type: esp-idf               # required
```

## Add-on

Copy `ruview/` to the Home Assistant `/addons` share, reload the add-on store
and install "RuView Sensing Server". It requires the Mosquitto broker add-on
(`services: mqtt:need`) and uses host networking so ESP32 nodes reach UDP 5005.
`udp_allow` restricts which source addresses may send CSI.
