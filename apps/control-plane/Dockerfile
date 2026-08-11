FROM node:24.13.1-bookworm-slim AS deploy

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

WORKDIR /repo
COPY . .
RUN pnpm --config.allow-unused-patches=true --ignore-scripts \
  --filter @t3tools/control-plane... install --frozen-lockfile \
  && pnpm --filter @t3tools/control-plane build \
  && pnpm --config.allow-unused-patches=true --ignore-scripts \
    --filter @t3tools/control-plane deploy --legacy --prod /out

FROM node:24.13.1-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=deploy --chown=node:node /out/ ./

USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["npm", "run"]
CMD ["start"]
