FROM oven/bun:1-alpine AS base
WORKDIR /usr/src/app

FROM base AS install
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
COPY patches /temp/prod/patches
RUN cd /temp/prod && bun install --frozen-lockfile --production

FROM base AS prerelease
COPY --from=install /temp/prod/node_modules node_modules
COPY . .

FROM base AS release

# NOTE: fix `sharp` memory leak
RUN apk add --no-cache jemalloc
ENV LD_PRELOAD=/usr/lib/libjemalloc.so.2

COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src/ src
COPY --from=prerelease /usr/src/app/tsconfig.json tsconfig.json
COPY --from=prerelease /usr/src/app/package.json package.json
COPY --from=prerelease /usr/src/app/scripts scripts
RUN mkdir -p /usr/src/app/logs /usr/src/app/media && chown -R bun:bun /usr/src/app/logs /usr/src/app/media

EXPOSE 3025
