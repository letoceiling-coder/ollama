# Образ для изолированной сборки студии (план §2, §5.2).
# Сборка локально: npm run studio-runner:build  (из каталога ollama-api)
#
# На проде зафиксировать digest образа node после проверки (воспроизводимость).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
