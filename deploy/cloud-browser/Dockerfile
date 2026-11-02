FROM mcr.microsoft.com/playwright:v1.55.0-jammy

USER root
WORKDIR /opt/fbb-build
COPY package.json ./
COPY extension ./extension
COPY scripts/package-extension.js ./scripts/package-extension.js
RUN node scripts/package-extension.js --variant cloud \
    && mv dist/field-browser-bridge-cloud-*/ /opt/fbb-extension

RUN npm install --prefix /opt/fbb-cloud --no-save playwright-core@1.55.0
COPY deploy/cloud-browser/pair.mjs /opt/fbb-cloud/pair.mjs
COPY deploy/cloud-browser/entrypoint.sh /usr/local/bin/fbb-cloud-entrypoint
COPY deploy/cloud-browser/chromium-policy.json /etc/chromium/policies/managed/fbb.json
COPY deploy/cloud-browser/chromium-policy.json /etc/opt/chrome/policies/managed/fbb.json
RUN chmod 0755 /usr/local/bin/fbb-cloud-entrypoint \
    && mkdir -p /profile \
    && chown -R pwuser:pwuser /profile /opt/fbb-extension /opt/fbb-cloud /opt/fbb-build

USER pwuser
WORKDIR /opt/fbb-cloud
VOLUME ["/profile"]
ENTRYPOINT ["/usr/local/bin/fbb-cloud-entrypoint"]
