# Apify standard Playwright actor template (leave as the generated default — see §15.2).
FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "Installed NPM packages:" && (npm list --omit=dev --all || true)

COPY --chown=myuser . ./

CMD npm run start --silent
