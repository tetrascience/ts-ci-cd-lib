# ts-ci-cd-lib <!-- omit in toc -->

Reusable CI/CD workflows for TetraScience repositories.

## Table of Contents <!-- omit in toc -->

- [Workflows](#workflows)
  - [e2e-codebuild](#e2e-codebuild)
  - [publish-npm-package](#publish-npm-package)
  - [check-links](#check-links)

## Workflows

### e2e-codebuild

Reusable workflow for running E2E tests via the shared `tdp-e2e` CodeBuild project. Handles deployment, environment resolution, S3 source upload, CodeBuild orchestration, and result polling. CodeBuild logs are streamed into the GHA step output and a job summary is written to the PR checks view.

#### Minimal usage

```yaml
name: E2E Tests

on:
  pull_request:
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
    secrets:
      JFROG_ARTIFACTORY_NPM_VIRTUAL_URL: ${{ secrets.JFROG_ARTIFACTORY_NPM_VIRTUAL_URL }}
      JFROG_ARTIFACTORY_READ_NPM_AUTH: ${{ secrets.JFROG_ARTIFACTORY_READ_NPM_AUTH }}
      GITHUB_PAT: ${{ secrets.ARTIFACT_BUILD_GITHUB_TS_DEVOPS_PAT }}
```

This will:
1. Check if any changed files match `deploy_paths`
2. If matched, push to the `predev5` branch and wait for the deploy workflow to complete
3. Run `yarn test:e2e` in CodeBuild against the (freshly deployed or current) service
4. Stream the full test output into the GHA step log

#### With custom env vars

```yaml
jobs:
  e2e:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/e2e-codebuild.yml@main
    with:
      environment: predev5
      deploy_paths: 'src/** package.json yarn.lock'
      env_vars_json: |
        {
          "E2E_ORG_SLUG": "tetrascience",
          "E2E_DATA_APP_SLUG": "threads"
        }
    secrets:
      JFROG_ARTIFACTORY_NPM_VIRTUAL_URL: ${{ secrets.JFROG_ARTIFACTORY_NPM_VIRTUAL_URL }}
      JFROG_ARTIFACTORY_READ_NPM_AUTH: ${{ secrets.JFROG_ARTIFACTORY_READ_NPM_AUTH }}
      GITHUB_PAT: ${{ secrets.ARTIFACT_BUILD_GITHUB_TS_DEVOPS_PAT }}
```

#### Playwright / browser tests

```yaml
jobs:
  e2e:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/e2e-codebuild.yml@main
    with:
      environment: predev5
      deploy_paths: 'src/** package.json yarn.lock'
      image_override: mcr.microsoft.com/playwright:v1.52.0-noble
      compute_type_override: BUILD_GENERAL1_MEDIUM
      buildspec: buildspec.e2e.yml  # use your own buildspec
    secrets:
      JFROG_ARTIFACTORY_NPM_VIRTUAL_URL: ${{ secrets.JFROG_ARTIFACTORY_NPM_VIRTUAL_URL }}
      JFROG_ARTIFACTORY_READ_NPM_AUTH: ${{ secrets.JFROG_ARTIFACTORY_READ_NPM_AUTH }}
      GITHUB_PAT: ${{ secrets.ARTIFACT_BUILD_GITHUB_TS_DEVOPS_PAT }}
```

#### E2E only (never deploy)

```yaml
jobs:
  e2e:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/e2e-codebuild.yml@main
    with:
      environment: predev5
      deploy_paths: ''  # empty = never deploy, just run tests
    secrets:
      JFROG_ARTIFACTORY_NPM_VIRTUAL_URL: ${{ secrets.JFROG_ARTIFACTORY_NPM_VIRTUAL_URL }}
      JFROG_ARTIFACTORY_READ_NPM_AUTH: ${{ secrets.JFROG_ARTIFACTORY_READ_NPM_AUTH }}
      GITHUB_PAT: ${{ secrets.ARTIFACT_BUILD_GITHUB_TS_DEVOPS_PAT }}
```

#### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `environment` | Target environment (e.g. predev5, dev) | **Yes** | |
| `deploy_paths` | Space-separated globs — deploy if changed files match. Empty = never deploy. | **Yes** | |
| `deploy_workflow` | Workflow file that builds and deploys the service (waited on after pushing to env branch) | No | `ci.yml` |
| `buildspec` | Path to a custom buildspec in the caller repo (empty = use shared default) | No | `""` |
| `env_vars_json` | JSON object of env vars to pass to CodeBuild | No | `{}` |
| `image_override` | Override CodeBuild base image | No | |
| `compute_type_override` | Override CodeBuild compute type (e.g. `BUILD_GENERAL1_MEDIUM`) | No | |
| `timeout_minutes` | Max minutes for the E2E job | No | `20` |

#### Secrets

| Secret | Description | Required |
|--------|-------------|----------|
| `JFROG_ARTIFACTORY_NPM_VIRTUAL_URL` | JFrog npm registry URL | Yes |
| `JFROG_ARTIFACTORY_READ_NPM_AUTH` | JFrog npm registry credentials | Yes |
| `GITHUB_PAT` | PAT with cross-repo read access + repo write (for deploy push to env branch) | Yes |

#### How it works

The workflow has three jobs:

**check-changes** (skipped if `deploy_paths` is empty):
1. Compares changed files against `deploy_paths` globs
2. Outputs `should_deploy=true` if any service code changed

**deploy** (only if `should_deploy=true`):
1. Force-pushes the current commit to the target environment branch (e.g. `predev5`) using `GITHUB_PAT`
2. Waits for the repo's deploy workflow (default: `ci.yml`) to build, push, and deploy the service

**e2e** (always runs after deploy succeeds or is skipped):
1. Checks out the caller repo and the environment config from `ts-cloudformation-service`
2. Resolves the target environment (account, region, base URL, SSM prefix)
3. Assumes the `gha-tdp-e2e-{env}` OIDC role in the target AWS account
4. Zips the source and uploads to the `tdp-e2e-source-{account}` S3 bucket
5. Starts a CodeBuild build with the buildspec, env vars, and optional image/compute overrides
6. Polls until CodeBuild completes
7. Fetches the full CloudWatch log stream and prints it in the GHA step output
8. Writes a job summary with status, environment, and log link

#### Default buildspec

When no custom `buildspec` is provided, the workflow uses [`buildspecs/e2e-default.yml`](buildspecs/e2e-default.yml) which:
- Reads the E2E auth token from SSM (`/tetrascience/{ssm_env}/e2e/E2E_TS_AUTH_TOKEN`)
- Sets up Node 20, corepack, and Yarn 4
- Configures the JFrog npm registry via `yarn config set`
- Runs `yarn install --immutable`
- Runs `yarn test:e2e`

Callers who need a different test command or setup should provide their own buildspec via the `buildspec` input.

#### Infrastructure prerequisites

The shared CodeBuild project must be deployed to each target environment. See [`ts-cloudformation-service/infrastructure/tdp-e2e.yaml`](https://github.com/tetrascience/ts-cloudformation-service/blob/development/infrastructure/tdp-e2e.yaml) and the [data-apps README](https://github.com/tetrascience/ts-service-data-apps#adding-a-new-environment) for setup instructions.

### publish-npm-package

Reusable workflow for publishing npm packages to JFrog Artifactory or the public npm registry.

#### Usage

```yaml
name: Publish

on:
  push:
    tags:
      - "v*"

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

#### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `node_version` | Node.js version | No | `"20"` |
| `prerelease_tag` | Prerelease tag for version suffix and npm dist-tag (e.g., alpha, beta). Leave empty for non-prerelease versions. | No | `""` |
| `run_tests` | Whether to run tests before publishing | No | `true` |
| `publish_to_public_npm` | Set to true to confirm publishing to public npm registry | No | `false` |

#### Secrets

| Secret | Description | Required |
|--------|-------------|----------|
| `AUTH_TOKEN` | Authentication token for JFrog Artifactory | Yes |
| `REGISTRY` | JFrog Artifactory npm registry URL (for installing dependencies) | Yes |
| `PUBLISH_REGISTRY` | Registry URL for publishing the package | Yes |
| `NPM_TOKEN` | npm token (required when publishing to public npm registry) | No |

#### Publishing to Public npm Registry

To publish to the public npm registry (`https://registry.npmjs.org`):

1. Set `publish_to_public_npm: true` in the workflow inputs
2. Provide the `NPM_TOKEN` secret
3. Set `PUBLISH_REGISTRY` to `https://registry.npmjs.org`

The workflow will automatically update the package scope from `@tetrascience` to `@tetrascience-npm` when publishing to the public registry.

### check-links

Reusable workflow for checking broken links in markdown files using [lychee](https://lychee.cli.rs/). The calling repository provides its own `lychee.toml` configuration file in the repo root.

#### Usage

```yaml
name: Link Check

on:
  push:
    branches: [main]
    paths: ["**/*.md", "lychee.toml", ".lycheeignore"]
  pull_request:
    paths: ["**/*.md", "lychee.toml", ".lycheeignore"]
  schedule:
    - cron: "0 8 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check-links:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/check-links.yml@main
```

#### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `lychee_args` | Arguments passed to lychee. The calling repo's `lychee.toml` handles most configuration. | No | `"--cache --max-cache-age 1d ."` |

#### Secrets

No secrets required. The workflow uses the automatically available `GITHUB_TOKEN` for authenticating with the GitHub API (to avoid rate limits when checking GitHub links).

#### Calling Repo Setup

Create a `lychee.toml` file in your repository root:

```toml
max_concurrency = 4
max_retries = 3
timeout = 20
accept = [200, 204, 301, 429]
exclude = [
  "^http://localhost",
  "^http://127\\.0\\.0\\.1",
  "^https?://example\\.com",
]
```
