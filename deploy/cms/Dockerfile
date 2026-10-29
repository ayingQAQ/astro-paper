FROM node:24-bookworm-slim
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN mkdir -p /data && chown node:node /data && chown -R node:node /app/node_modules
USER node
ENV NODE_ENV=production CMS_DATA_DIR=/data CMS_HOST=0.0.0.0 CMS_PORT=4444
EXPOSE 4444
CMD ["node", "cms/cli.mjs", "serve"]
