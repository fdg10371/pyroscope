FROM node:22-alpine AS build
ARG environment=dev
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY web/ web/
COPY tests/ tests/
COPY pof_explorer/static/ pof_explorer/static/
RUN npm test && npm run build

FROM nginx:1.28-alpine AS production
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
