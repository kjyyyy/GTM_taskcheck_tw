# Apify standard Node actor template (leave as the generated default — see §15.2).
FROM apify/actor-node:20

COPY package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "Installed NPM packages:" && (npm list --omit=dev --all || true)

COPY . ./

CMD npm run start --silent
