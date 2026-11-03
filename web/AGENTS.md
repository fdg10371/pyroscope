# Application Development

Use the existing npm lockfile, plain-JavaScript Vite application in `web/`, and
vendored assets in `pof_explorer/static/`. Keep the optional FastAPI backend and
its package layout unchanged unless the task specifically concerns that backend.

The browser reads Zarr directly in a worker. Preserve error reporting, bounded
concurrency and caching, probability units, coordinate handling, actual forecast
times, and the absence of a sample-data fallback.

Run `npm test` for frontend changes and `npm run build` for packaging changes.
The Docker build runs both commands using Node 22. For container changes, build
and run the image, then run
`CONTAINER_URL=http://127.0.0.1:8080 node --test tests/container.test.js`.
The README gives the complete commands.

Preserve `PAGES_BASE_PATH` for GitHub Pages; DSS containers build at `/` by
default. Public data URLs are build-time settings, never credentials. Keep the
current Work Sans typography and scientific colour scale rather than adopting
unrelated React/Mantine examples from the template.

Use the scientific and technical issue template before publishing significant
science/data changes. Container packaging alone does not change scientific logic.
