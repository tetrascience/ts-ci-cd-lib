# ts-ci-cd-lib <!-- omit in toc -->

Reusable CI/CD workflows for TetraScience repositories.

## Table of Contents <!-- omit in toc -->

- [Workflows](#workflows)
  - [actionlint](#actionlint)
  - [knip](#knip)
  - [publish-npm-package](#publish-npm-package)
  - [check-links](#check-links)
  - [e2e-codebuild](#e2e-codebuild)
- [Actions](#actions)
  - [install-jfrog-npm-package](#install-jfrog-npm-package)

## Workflows

### actionlint

Reusable workflow that runs [actionlint](https://github.com/rhysd/actionlint) to lint all GitHub Actions workflow files in the repo. Catches syntax errors, type mismatches, deprecated features, and security issues in workflow YAML.

#### Usage

```yaml
jobs:
  actionlint:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/actionlint.yml@main
```

#### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `version` | actionlint version to install | No | `"latest"` |

---

### knip

Reusable workflow that runs [knip](https://knip.dev/) to detect unused dependencies, exports, types, and files. Handles checkout, Node setup, Corepack, registry auth, install, and caching — callers just wire it up.

#### Usage

```yaml
jobs:
  knip:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/knip.yml@main
    secrets:
      AUTH_TOKEN: ${{ secrets.JFROG_ARTIFACTORY_READ_NPM_AUTH }}
      REGISTRY: ${{ secrets.JFROG_ARTIFACTORY_NPM_VIRTUAL_URL }}
```

#### With options

```yaml
  knip:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/knip.yml@main
    with:
      working_directory: packages/my-lib
      args: "--include dependencies"
    secrets:
      AUTH_TOKEN: ${{ secrets.JFROG_ARTIFACTORY_READ_NPM_AUTH }}
      REGISTRY: ${{ secrets.JFROG_ARTIFACTORY_NPM_VIRTUAL_URL }}
```

#### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `node_version` | Node.js version | No | `"20"` |
| `working_directory` | Directory to run knip in | No | `"."` |
| `args` | Additional arguments passed to knip | No | `""` |

#### Secrets

| Secret | Description | Required |
|--------|-------------|----------|
| `AUTH_TOKEN` | JFrog npm auth token (for installing private deps) | No |
| `REGISTRY` | JFrog virtual registry URL | No |

#### Husky pre-commit

Same tool, no workflow needed — add directly to `.husky/pre-commit`:

```sh
npx knip --include dependencies
```

#### Knip config

For most repos, knip works out of the box. If you need to ignore specific patterns, create `knip.json`:

```json
{
  "ignore": ["src/generated/**"],
  "ignoreDependencies": ["@types/*"]
}
```

---

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
| `working_directory` | Directory containing the package to publish | No | `"."` |
| `prerelease_tag` | Prerelease tag for version suffix and npm dist-tag (e.g., alpha, beta). Leave empty for non-prerelease versions. | No | `""` |
| `run_tests` | Whether to run tests before publishing | No | `true` |
| `publish_to_public_npm` | Set to true to confirm publishing to public npm registry | No | `false` |
| `pre_install_command` | Shell command to run after checkout + auth but before install. Runs at repo root (not `working_directory`) in the same job environment, including any provided secrets/tokens. Use for codegen that produces the `working_directory` contents, and avoid echoing or logging sensitive values. | No | `""` |

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

---

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

#### Environment config

Non-secret test configuration (org slugs, app IDs, subdomain bases, etc.) should live in the service repo as a static config file (e.g. `test/e2e/environments.ts`) keyed by environment name. The workflow passes `E2E_ENVIRONMENT` so tests can select the right config at runtime. Only actual secrets (auth tokens) belong in SSM.

#### Buildspec

Each service provides its own `buildspec.e2e.yml`. The workflow passes the following as CodeBuild environment variables:

| Variable | Description |
|----------|-------------|
| `E2E_ENVIRONMENT` | Target environment name (e.g. `predev3`, `dev`) |
| `JFROG_ARTIFACTORY_URL` | JFrog npm registry URL |
| `JFROG_ARTIFACTORY_AUTH` | JFrog npm credentials |

Authentication is handled by each service's test setup (e.g. a `globalSetup` that reads the TDP admin password from SSM and logs in). The CodeBuild IAM role has access to read SSM parameters under `/tetrascience/{environment}/platform/ADMIN_PASSWORD`.

Example buildspec:

```yaml
version: 0.2

phases:
  install:
    runtime-versions:
      nodejs: 20
    commands:
      - npm install -g corepack
      - corepack enable
      - YARN_VERSION=$(node -p "require('./package.json').packageManager.split('@')[1]")
      - corepack prepare "yarn@$YARN_VERSION" --activate
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
| `environment` | **Yes** | | Target environment. One of `predev`, `predev2`…`predev8`, `dev`, `preuat`, `uat`. |
| `deploy_paths` | **Yes** | | Globs that trigger deploy. Empty = never deploy (observe-only, see below). |
| `buildspec` | **Yes** | | Path to buildspec in the caller repo |
| `deploy_workflow` | No | `ci.yml` | Workflow waited on after pushing to env branch |
| `image_override` | No | | Override CodeBuild image |
| `compute_type_override` | No | | Override CodeBuild compute (e.g. `BUILD_GENERAL1_MEDIUM`) |
| `timeout_minutes` | No | `25` | Max minutes for the E2E job |

#### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `JFROG_ARTIFACTORY_NPM_VIRTUAL_URL` | **Yes** | JFrog npm registry URL |
| `JFROG_ARTIFACTORY_READ_NPM_AUTH` | **Yes** | JFrog npm credentials |
| `GITHUB_PAT` | **Yes** | PAT for cross-repo access + deploy push |
| `ZEPHYR_CYCLE_KEY` | No | Cycle to record into |
| `ZEPHYR_API_TOKEN` | No | Zephyr Scale API token |
| `ZEPHYR_ACCOUNT_ID` | No | Jira account id for `executedById` |

The three Zephyr secrets are forwarded as CodeBuild environment variables **only when
non-empty**, so omitting them leaves the buildspec's own lookups in charge. Pass them
when the caller already holds these values as GitHub secrets.

> **Buildspec authors:** a buildspec that assigns these unconditionally will clobber
> what the workflow passes. Prefer the inbound value:
> ```sh
> export ZEPHYR_CYCLE_KEY="${ZEPHYR_CYCLE_KEY:-$(aws ssm get-parameter ... || echo "")}"
> ```

#### How it works

1. **check-changes** — compares changed files against `deploy_paths`. Skipped if `deploy_paths` is empty.
2. **deploy** — pushes to the env branch, waits for the deploy workflow to complete. Skipped if no service code changed.
3. **e2e** — uploads source to S3, triggers CodeBuild, streams logs, writes job summary.

#### Observe-only mode

Passing `deploy_paths: ''` skips **check-changes** and **deploy**, leaving only the
CodeBuild run. Use it against environments this pipeline does not deploy, so the suite
verifies what is already there rather than what a PR would ship. Those environments
reject a non-empty `deploy_paths` outright.

Pair it with a `workflow_dispatch` trigger in the caller. The caller workflow must exist
on whichever branch you dispatch from.

```yaml
on:
  workflow_dispatch:

jobs:
  e2e:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/e2e-codebuild.yml@main
    with:
      environment: uat
      deploy_paths: ''
      buildspec: buildspec.e2e.yml
    secrets: ...
```

`GITHUB_PAT` is still declared required even though nothing uses it once the deploy job
is skipped.

#### Infrastructure

The shared CodeBuild project (`tdp-e2e`) must exist in the target account before an
environment can be used. It comes from
[`ts-cloudformation-service/infrastructure/tdp-e2e.yaml`](https://github.com/tetrascience/ts-cloudformation-service/blob/development/infrastructure/tdp-e2e.yaml),
deployed either as a substack of the TDP service stack via `EnableE2E=true` or as a
standalone stack. One project per account serves every repo: source and buildspec are
per-call overrides, and uploads are namespaced by repo name.

The workflow derives the role and bucket names by convention, so an environment's
`CF_ENVIRONMENTS` entry must match that stack's `EnvironmentName`.

## Actions

Composite actions are referenced as a **step** (`uses:`) inside your own job, unlike the reusable workflows above (which are referenced at the job level).

### install-jfrog-npm-package

Installs a single npm package that is published **only** to a private JFrog Artifactory registry, as a leaf tarball extracted into an already-installed `node_modules`.

Use this for packages that cannot be added to `package.json` / `yarn.lock` — for example in a repo pinned to the public npm registry, where adding a private dependency would break external contributors' `yarn install`. The action fetches just the one package via `npm pack` and extracts it in place; it deliberately does **not** use `npm install`, which reconciles the whole dependency tree and corrupts a Yarn-managed `node_modules` (`ENOTEMPTY … rmdir node_modules/<pkg>/dist`).

#### Usage

Run it **after** `yarn install` (it extracts into the existing `node_modules`):

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: "24"
      cache: "yarn"
  - run: corepack enable
  - run: yarn install --immutable

  - name: Install ts-lib-zephyr-nodejs (JFrog)
    uses: tetrascience/ts-ci-cd-lib/install-jfrog-npm-package@main
    with:
      package: ts-lib-zephyr-nodejs
      version: "0.4.0"
      # The virtual registry URL is infra info, not a credential — hardcode it
      # (or pass a non-environment-scoped secret).
      registry-url: https://<org>.jfrog.io/artifactory/api/npm/<repo>/
      auth: ${{ secrets.JFROG_ARTIFACTORY_READ_NPM_AUTH }}
```

#### Inputs

| Input          | Description                                                                                          | Required | Default |
| -------------- | ---------------------------------------------------------------------------------------------------- | -------- | ------- |
| `package`      | npm package name to install (e.g. `ts-lib-zephyr-nodejs`). Scoped names are supported.               | Yes      | —       |
| `version`      | Exact version to install (e.g. `0.4.0`).                                                             | Yes      | —       |
| `registry-url` | JFrog virtual (read) registry URL, e.g. `https://<org>.jfrog.io/artifactory/api/npm/<repo>/`.        | Yes      | —       |
| `auth`         | Read-only Artifactory credential; interpreted per `auth-type`. Pass a secret.                        | Yes      | —       |
| `auth-type`    | npm auth field: `_auth` (base64 `username:password`) or `_authToken` (bearer token).                 | No       | `_auth` |

> **auth-type:** most TetraScience `JFROG_ARTIFACTORY_*_NPM_AUTH` secrets are a base64 `username:password` identity (npm `_auth`, equivalent to Yarn's `npmAuthIdent`) — the default. Set `auth-type: _authToken` only if your credential is a bearer token.
