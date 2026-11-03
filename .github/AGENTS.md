# DSS Application CI/CD Guidelines

DSS applications are containerised and their images built through GitHub Actions; they are deployed by Argo CD from the [dss-applications-argocd-configs](https://github.com/ecmwf/dss-applications-argocd-configs) repository, not from GitHub Actions. This file covers build configuration, workflows, and pulling in template updates. For application development, see `src/AGENTS.md`; Helm values are covered by `deployment/AGENTS.md`.

## CI build & deploy options

CI build behaviour is configured through the `.github/options*.env` files, which are sourced by the `build.yml` workflow (and by the legacy `deploy.yml`, see below). All variables have defaults — only uncomment what you need to override:

| File | Purpose |
|------|---------|
| `.github/options.env` | Shared build/deploy defaults |
| `.github/options-dev.env` | Dev-specific overrides |
| `.github/options-prod.env` | Prod-specific overrides |

Supported variables (with their defaults):
- **Build:** `IMAGE_PROJECT` (`c3s-applications`), `IMAGE_REPOSITORY` (the GitHub repo name).
- **Deploy (legacy `deploy.yml` only, ignored by Argo CD):** `RELEASE_NAME` (the GitHub repo name), `NAMESPACE` (`cads-apps-<environment>`), `HELM_CHART` (`oci://eccr.ecmwf.int/c3s-applications/single-pod-application`), `HELM_CHART_VERSION`, `KUBECONFIG` (`/home/cds/.kubeconfig`), `VALUES_FILE` (`deployment/values.yaml,deployment/values-<environment>.yaml`), `HELM_EXTRA_ARGS`.

## GitHub Actions

The template ships two manually-triggered (`workflow_dispatch`) workflows: `build.yml` (**Build & push to Harbor**) and `deploy.yml` (**Deploy Single Pod Application Chart**).

- `deploy.yml` is **legacy**: it deploys with `helm upgrade` from the runner, for applications not yet migrated to Argo CD. Never run it, or add deploy steps to any workflow, for an application deployed by Argo CD: Argo CD self-heals and reverts such changes. Releasing a new image for an Argo CD application is a change in the configs repository (a new `deployment.tag`), or a deployment restart for `latest`.
- **Build:** the `load_options` job runs on `ubuntu-latest`; image build/push is delegated to the reusable workflow. **Deploy:** the `deploy` job runs on `self-hosted`.
- The image tag is the `image_tag` workflow input (defaults to `latest`; leave blank to use the commit SHA).
- Builds require `HARBOR_USERNAME` and `HARBOR_PASSWORD`. Deployments do not use those registry secrets; `SECRET_VALUES_YAML` is used only by the legacy `deploy.yml`. Under Argo CD, credentials are Kubernetes Secrets applied by a cluster administrator, never stored in GitHub or in git.
- The `build.yml` workflow uses the [ecmwf/reusable-workflows](https://github.com/ecmwf/reusable-workflows) `build-and-push-image` reusable workflow — do not inline the Docker build/push steps manually.
- Do not reference `secrets.*` inside `jobs.<id>.with` inputs; pass secrets only via `jobs.<id>.secrets`.

## Updating from the Template

Downstream repositories created from this template can pull in updates to the `.github/` folder. The merge precedence rule is:

- **Template wins** for `.github/workflows/` and `.github/ISSUE_TEMPLATE/` — these files from the template always replace the downstream versions.
- **Downstream wins** for the rest of `.github/` — the downstream repo's `options*.env` customisations take precedence over template changes.

### Procedure

1. **Add the template as a remote** (once per clone):

   ```bash
   git remote add template https://github.com/ecmwf/dss-application-template.git
   ```

2. **Fetch the latest template changes:**

   ```bash
   git fetch template main
   ```

3. **Create a branch for the update:**

   ```bash
   git checkout -b chore/update-template
   ```

4. **Restore only the template-owned `.github/` paths:**

   ```bash
   git checkout template/main -- .github/workflows/ .github/ISSUE_TEMPLATE/
   ```

5. **Review the template versions of downstream-owned option files.** Adopt changes selectively; do not overwrite downstream settings without reviewing them:

   ```bash
   git diff template/main -- .github/options.env .github/options-dev.env .github/options-prod.env
   ```

6. **Commit and open a PR:**

   ```bash
   git add .github/
   git commit -m "chore: update .github from dss-application-template"
   ```

### What gets updated

Pyroscope-specific exceptions: preserve `pages.yml` and `container.yml`, and do
not import the legacy `deploy.yml`. DSS deployment belongs in the Argo CD configs
repository. Application guidance lives in `web/AGENTS.md`, not `src/AGENTS.md`.

| Path | Precedence | Notes |
|------|-----------|-------|
| `.github/workflows/*.yml` | **Template** | Always replaced wholesale |
| `.github/ISSUE_TEMPLATE/` | **Template** | Always replaced wholesale |
| `.github/options*.env` | Downstream | Review template changes manually; adopt as needed |
