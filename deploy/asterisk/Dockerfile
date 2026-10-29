# Asterisk 22 LTS, built from the official source with the modules NexusAI
# uses: PJSIP over TLS, ARI, the WebSocket media channel and answering-machine
# detection. No sound packs: every prompt is NexusAI's own.
FROM ubuntu:22.04

ARG AST_VERSION=22.11.0
ARG AST_SHA256=3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bzip2 patch \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN curl -fsSLO https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${AST_VERSION}.tar.gz \
 && echo "${AST_SHA256}  asterisk-${AST_VERSION}.tar.gz" | sha256sum -c - \
 && tar xzf asterisk-${AST_VERSION}.tar.gz \
 && rm asterisk-${AST_VERSION}.tar.gz

WORKDIR /usr/src/asterisk-${AST_VERSION}
RUN apt-get update && contrib/scripts/install_prereq install

RUN ./configure --with-pjproject-bundled \
 && make menuselect.makeopts \
 && menuselect/menuselect --disable BUILD_NATIVE \
      --disable-category MENUSELECT_CORE_SOUNDS \
      --disable-category MENUSELECT_EXTRA_SOUNDS \
      --disable-category MENUSELECT_MOH \
      menuselect.makeopts \
 && make -j"$(nproc)" \
 && make install \
 && ldconfig \
 && for module in res_pjsip res_pjsip_outbound_registration res_ari res_stasis \
      res_http_websocket res_websocket_client chan_websocket app_amd codec_alaw \
      codec_resample bridge_softmix format_pcm format_sln format_wav; do \
      test -f /usr/lib/asterisk/modules/$module.so || { echo "missing $module"; exit 1; }; \
    done \
 && cd / && rm -rf /usr/src/asterisk-${AST_VERSION} \
 && rm -rf /var/lib/apt/lists/*

# A fixed id, so the line files on the host can be owned by it.
RUN groupadd --system --gid 2000 asterisk \
 && useradd --system --uid 2000 --gid 2000 --home-dir /var/lib/asterisk asterisk \
 && mkdir -p /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk \
 && chown -R asterisk:asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk

COPY conf/ /etc/asterisk/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
