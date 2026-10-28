# syntax=docker/dockerfile:1
# Aura Companion server image (PLAN-aura-uiux-agent-enrichment Task 9, spec AC2.1).
#
# Built FROM THE NPM TARBALL, so the image carries exactly what npm users get,
# including the shipped UI/UX skill pack (packs/skills is staged by `prepack`,
# see web/scripts/skill-pack-build.ts). The boot step installs it into
# ~/.companion/skill-pack and new sessions get it via --plugin-dir (Claude) or
# marked copies (Codex).
#
# Pinned: the bun and node base images by digest, Claude Code and Codex by version.
# python3 (+ the `python` alias ui-ux-pro-max's documented commands use) and node are on
# PATH so shipped skills can run their scripts.
#
#   docker build -t aura-companion .
#   docker run -p 3456:3456 -v aura-home:/home/node aura-companion
#
# All state (sessions, ~/.companion, CLI logins) lives in /home/node: mount a volume.
# Sessions run inside this container; Aura's Docker "container sessions" need a
# Docker daemon and are not wired here.

ARG BUN_IMAGE=oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# ── 1. Build the npm tarball (runs prepack → stages packs/skills) ───────────
FROM ${BUN_IMAGE} AS pack
COPY . /src
WORKDIR /src/web
RUN bun install --frozen-lockfile \
 && bun run build \
 && mkdir /out \
 && bun pm pack --destination /out \
 && cp bun.lock /out/bun.lock

FROM ${BUN_IMAGE} AS bun

# ── 2. Runtime: node 22 + python3 + bun + the CLIs + the tarball ────────────
FROM ${NODE_IMAGE}
ARG CLAUDE_CODE_VERSION=2.1.283
ARG CODEX_VERSION=0.162.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python-is-python3 git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN npm install -g --no-audit --no-fund \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

COPY --from=pack /out /tmp/pack
RUN mkdir -p /opt/aura-companion \
 && tar xzf /tmp/pack/aura-companion-*.tgz -C /opt/aura-companion --strip-components=1 \
 && cp /tmp/pack/bun.lock /opt/aura-companion/bun.lock \
 && cd /opt/aura-companion \
 && bun install --production --frozen-lockfile \
 && rm -rf /tmp/pack \
 && test -f packs/skills/skills-manifest.json

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3456 \
    PYTHONDONTWRITEBYTECODE=1
USER node
WORKDIR /home/node
EXPOSE 3456
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3456/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "/opt/aura-companion/bin/cli.ts", "serve"]
