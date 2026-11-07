# Home Assistant add-on wrapper around the published multi-arch sensing-server
# image (built by .github/workflows/sensing-server-docker.yml with the `mqtt`
# feature). `latest` keeps the add-on on upstream updates: a Rebuild pulls the
# current image instead of a hand-maintained pin.
ARG BUILD_FROM=ruvnet/wifi-densepose:latest
FROM ${BUILD_FROM}

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl jq \
 && rm -rf /var/lib/apt/lists/*

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]
