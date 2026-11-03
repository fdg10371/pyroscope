# Pyroscope Agent Guidelines

Pyroscope follows the DSS application template's Vite/static container pattern.
The application is plain JavaScript, not React. Preserve its direct-Zarr reader,
scientific interpretation, self-hosted assets, and optional Python backend.
Do not introduce a framework or move code solely to match template examples.

- Read `web/AGENTS.md` before changing application code, tests, or build configuration.
- Read `.github/AGENTS.md` before changing workflows or build options.
- The Docker image serves the Vite frontend through Nginx on port 80. The Python
  backend is a separate local option and is not included in that image.
- Keep the GitHub Pages publishing and container check workflows alongside the
  template-owned Harbor image build when refreshing template workflows.
- DSS deployment settings belong in `ecmwf/dss-applications-argocd-configs`.
  Do not add the template's legacy Helm deploy workflow or deployment values.
- Never commit credentials or put them in frontend configuration.

See README.md for packaging, validation, deployment, and template update steps.
