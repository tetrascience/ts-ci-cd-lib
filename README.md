# ts-ci-cd-lib <!-- omit in toc -->

Reusable CI/CD workflows for TetraScience repositories.

## Table of Contents <!-- omit in toc -->

- [Workflows](#workflows)
  - [e2e-codebuild](#e2e-codebuild)
  - [publish-npm-package](#publish-npm-package)
  - [check-links](#check-links)

## Workflows

### e2e-codebuild

Deploys a service to a predev environment, runs E2E tests via CodeBuild, and streams results back to the PR.

#### Usage

```yaml
name: E2E Tests

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled]
  push:
    branches: [development]

permissions:
  id-token: write
  contents: read

jobs:
  e2e:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/e2e-codebuild.yml@main
    with:
      environment: predev5
      deploy_paths: 'src/** migrations/** package.json yarn.lock Dockerfile'
      buildspec: buildspec.e2e.yml
    secrets:
      JFROG_ARTIFACTORY_NPM_VIRTUAL_URL: ${{ secrets.JFROG_ARTIFACTORY_NPM_VIRTUAL_URL }}
      JFROG_ARTIFACTORY_READ_NPM_AUTH: ${{ secrets.JFROG_ARTIFACTORY_READ_NPM_AUTH }}
      GITHUB_PAT: ${{ secrets.ARTIFACT_BUILD_GITHUB_TS_DEVOPS_PAT }}
```

#### Buildspec

Each service provides its own `buildspec.e2e.yml`. The workflow passes `E2E_BASE_URL`, `E2E_SERVICE_NAME`, `JFROG_ARTIFACTORY_URL`, and `JFROG_ARTIFACTORY_AUTH` as CodeBuild environment variables. Additional env vars can be passed via `env_vars_json`.

The auth token is read from SSM at `/tdp/e2e/{E2E_SERVICE_NAME}/auth-token` — each service has its own token per account.

Example buildspec:

```yaml
version: 0.2

phases:
  install:
    runtime-versions:
      nodejs: 20
    commands:
      - |
        SSM_PATH="/tdp/e2e/${E2E_SERVICE_NAME}/auth-token"
        export E2E_TS_AUTH_TOKEN=$(aws ssm get-parameter --name "$SSM_PATH" --with-decryption --query 'Parameter.Value' --output text)
      - npm install -g corepack
      - corepack enable
      - corepack prepare yarn@4.0.2 --activate
      - |
        if [ -n "$JFROG_ARTIFACTORY_URL" ]; then
          yarn config set npmRegistryServer "$JFROG_ARTIFACTORY_URL"
          yarn config set npmAuthIdent "$JFROG_ARTIFACTORY_AUTH"
          yarn config set npmAlwaysAuth true
        fi
      - yarn install --immutable
  build:
    commands:
      - yarn test:e2e
```

#### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `environment` | **Yes** | | Target environment (e.g. `predev5`, `dev`) |
| `deploy_paths` | **Yes** | | Globs that trigger deploy. Empty = skip deploy. |
| `buildspec` | **Yes** | | Path to buildspec in the caller repo |
| `deploy_workflow` | No | `ci.yml` | Workflow waited on after pushing to env branch |
| `env_vars_json` | No | `{}` | Extra env vars as `{"KEY": "value"}` |
| `image_override` | No | | Override CodeBuild image |
| `compute_type_override` | No | | Override CodeBuild compute (e.g. `BUILD_GENERAL1_MEDIUM`) |
| `timeout_minutes` | No | `20` | Max minutes for the E2E job |

#### Secrets

| Secret | Description |
|--------|-------------|
| `JFROG_ARTIFACTORY_NPM_VIRTUAL_URL` | JFrog npm registry URL |
| `JFROG_ARTIFACTORY_READ_NPM_AUTH` | JFrog npm credentials |
| `GITHUB_PAT` | PAT for cross-repo access + deploy push |

#### How it works

1. **check-changes** — compares changed files against `deploy_paths`. Skipped if `deploy_paths` is empty.
2. **deploy** — pushes to the env branch, waits for the deploy workflow to complete. Skipped if no service code changed.
3. **e2e** — uploads source to S3, triggers CodeBuild, streams logs, writes job summary.

#### Infrastructure

The shared CodeBuild project (`tdp-e2e`) must be deployed per environment. See [`ts-cloudformation-service/infrastructure/tdp-e2e.yaml`](https://github.com/tetrascience/ts-cloudformation-service/blob/development/infrastructure/tdp-e2e.yaml).

To provision a new service's auth token:

```sh
aws ssm put-parameter \
  --name "/tdp/e2e/<repo-name>/auth-token" \
  --type SecureString \
  --value "<token>" \
  --profile <env> --region <region>
```

---

### publish-npm-package

Publishes npm packages to JFrog Artifactory or the public npm registry.

#### Usage

```yaml
jobs:
  publish:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/publish-npm-package.yml@main
    with:
      node_version: "20"
    secrets:
      AUTH_TOKEN: ${{ secrets.JFROG_AUTH_TOKEN }}
      REGISTRY: ${{ secrets.JFROG_NPM_REGISTRY }}
      PUBLISH_REGISTRY: ${{ secrets.JFROG_NPM_PUBLISH_REGISTRY }}
```

Supports `working_directory` for subdirectory packages, `prerelease_tag` for pre-releases, and `publish_to_public_npm` for public registry.

---

### check-links

Checks broken links in markdown files using [lychee](https://lychee.cli.rs/).

#### Usage

```yaml
jobs:
  check-links:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/check-links.yml@main
```

Requires a `lychee.toml` config in the caller repo root.
