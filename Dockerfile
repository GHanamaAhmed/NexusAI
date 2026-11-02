# The API, the worker and the voice app: targets api, worker and voice, each
# holding only its own production dependencies, run as the unprivileged node
# user. TypeScript runs through tsx, as in development; there's no build step.
FROM node:24-slim AS build
RUN npm install --global pnpm@10.33.4
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && for app in api worker voice; do \
      pnpm --filter "@nexus/$app" deploy --legacy --prod "/out/$app"; \
    done

FROM node:24-slim AS app
ENV NODE_ENV=production
WORKDIR /app
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]

FROM app AS api
COPY --from=build /out/api /app
EXPOSE 3000

FROM app AS worker
COPY --from=build /out/worker /app

FROM app AS voice
COPY --from=build /out/voice /app
