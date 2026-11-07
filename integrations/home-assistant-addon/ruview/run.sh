#!/bin/sh
# Start the RuView sensing server with options from the add-on UI and the MQTT
# broker credentials Home Assistant's Supervisor hands out (services: mqtt).
set -eu

OPTS=/data/options.json
opt() { jq -r --arg k "$1" '.[$k] // empty' "$OPTS"; }

HTTP_PORT="$(opt http_port)"
WS_PORT="$(opt ws_port)"
UDP_PORT="$(opt udp_port)"
UDP_ALLOW="$(opt udp_allow)"
API_TOKEN="$(opt api_token)"
PRIVACY="$(opt privacy_mode)"
PREFIX="$(opt mqtt_prefix)"
export RUST_LOG="$(opt log_level)"

MQTT_JSON="$(curl -fsS -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" http://supervisor/services/mqtt)"
MQTT_HOST="$(echo "$MQTT_JSON" | jq -r '.data.host')"
MQTT_PORT="$(echo "$MQTT_JSON" | jq -r '.data.port')"
MQTT_USER="$(echo "$MQTT_JSON" | jq -r '.data.username')"
export MQTT_PASSWORD="$(echo "$MQTT_JSON" | jq -r '.data.password')"
# The server refuses plaintext MQTT to a non-local broker (ADR-115 §3.9). The
# add-on runs on the host network and the Mosquitto add-on publishes 1883 on
# the host, so talk to it over loopback instead of the internal hostname.
case "$MQTT_HOST" in
    core-mosquitto|core_mosquitto|*.local.hass.io) MQTT_HOST=127.0.0.1 ;;
esac

# Persistent per-installation signing seed instead of the deterministic dev key.
SEED_FILE=/data/rufield_signing_seed
if [ ! -s "$SEED_FILE" ]; then
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SEED_FILE"
    chmod 600 "$SEED_FILE"
fi
export WDP_RUFIELD_SIGNING_SEED="$(cat "$SEED_FILE")"

if [ -n "$API_TOKEN" ]; then
    export RUVIEW_API_TOKEN="$API_TOKEN"
else
    # The server refuses an unauthenticated non-loopback bind unless told the
    # network is trusted. This add-on serves the home LAN only.
    export RUVIEW_ALLOW_UNAUTHENTICATED=1
    echo "[ruview] api_token is empty: REST/WebSocket on :${HTTP_PORT} are unauthenticated on the LAN" >&2
fi

export RUVIEW_DATA_DIR=/data/ruview
export MODELS_DIR=/data/ruview/models
mkdir -p "$MODELS_DIR"

set -- /app/sensing-server \
    --source esp32 \
    --tick-ms 100 \
    --ui-path /app/ui \
    --http-port "$HTTP_PORT" \
    --ws-port "$WS_PORT" \
    --udp-port "$UDP_PORT" \
    --bind-addr 0.0.0.0 \
    --udp-bind 0.0.0.0 \
    --udp-allow "$UDP_ALLOW" \
    --mqtt \
    --mqtt-host "$MQTT_HOST" \
    --mqtt-port "$MQTT_PORT" \
    --mqtt-username "$MQTT_USER" \
    --mqtt-prefix "$PREFIX"

if [ "$PRIVACY" = "true" ]; then
    set -- "$@" --privacy-mode
fi

echo "[ruview] CSI on udp/${UDP_PORT} (allow ${UDP_ALLOW}), UI :${HTTP_PORT}, MQTT ${MQTT_USER}@${MQTT_HOST}:${MQTT_PORT}" >&2
cd /app
exec "$@"
