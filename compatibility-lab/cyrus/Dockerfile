ARG CYRUS_BUILD_IMAGE=ghcr.io/cyrusimap/cyrus-docker:trixie@sha256:2230f54eff887845d81a51e9c35362b66d6e5c6cbcc2825f84d44678a5871a3d
FROM ${CYRUS_BUILD_IMAGE}

ARG CYRUS_REF=cyrus-imapd-3.13.6
ARG CYRUS_COMMIT=248be58c89fc7f841e5117a4269c8e05ac9a93ea

RUN mkdir -p /srv/cyrus-imapd \
 && cd /srv/cyrus-imapd \
 && git init \
 && git remote add origin https://github.com/cyrusimap/cyrus-imapd.git \
 && git fetch --depth 1 origin "refs/tags/${CYRUS_REF}:refs/tags/${CYRUS_REF}" \
 && test "$(git rev-list -n 1 "${CYRUS_REF}")" = "${CYRUS_COMMIT}" \
 && git checkout --detach "${CYRUS_REF}" \
 && cyd build -n --jobs 4

RUN apt-get update \
 && apt-get install --yes --no-install-recommends sasl2-bin \
 && rm -rf /var/lib/apt/lists/*

COPY imapd.conf /etc/imapd.conf
COPY cyrus.conf /etc/cyrus.conf
COPY smtp-sink.py /usr/local/bin/cyrus-lab-smtp-sink
COPY start-cyrus.sh /usr/local/bin/start-cyrus-lab

RUN chmod 0755 /usr/local/bin/cyrus-lab-smtp-sink /usr/local/bin/start-cyrus-lab

EXPOSE 1025 8080 1143

ENTRYPOINT ["/usr/local/bin/start-cyrus-lab"]
