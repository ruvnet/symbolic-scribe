# Stage 1: build the static Vite bundle (served at "/", not the Pages base path).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: serve dist/ with nginx on port 8080 (Fly internal_port).
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
RUN sed -i \
      -e 's/listen\(.*\)80;/listen 8080;/' \
      -e 's#index  index.html index.htm;#index  index.html index.htm;\n        try_files $uri $uri/ /index.html;#' \
      /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
