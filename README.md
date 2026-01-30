# ts-ci-cd-lib <!-- omit in toc -->

Reusable CI/CD workflows for TetraScience repositories.

## Table of Contents <!-- omit in toc -->

- [Workflows](#workflows)
  - [publish-npm-package](#publish-npm-package)
  - [zephyr-sync-tests](#zephyr-sync-tests)
  - [zephyr-report-results](#zephyr-report-results)
- [Scripts](#scripts)
  - [sync-zephyr.ts](#sync-zephyrts)
  - [report-zephyr-results.ts](#report-zephyr-resultsts)

## Workflows

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

### zephyr-sync-tests

Reusable workflow for syncing Playwright/Storybook E2E tests to Zephyr Scale. This workflow scans test files, creates test cases in Zephyr, and updates test files with assigned Zephyr IDs.

#### Usage

```yaml
name: Sync Zephyr Tests

on:
  workflow_dispatch:
  push:
    branches:
      - main
    paths:
      - "tests/e2e/**"

jobs:
  sync:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/zephyr-sync-tests.yml@main
    with:
      test_dirs: "tests/e2e"
      zephyr_folders: '{"my-app": "My App Tests"}'
      zephyr_labels: "e2e,playwright,automated"
    secrets:
      ZEPHYR_TOKEN: ${{ secrets.ZEPHYR_TOKEN }}
```

#### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `node_version` | Node.js version | No | `"20"` |
| `test_dirs` | Comma-separated list of test directories to scan | Yes | - |
| `test_file_pattern` | File pattern to match test files | No | `".spec.ts"` |
| `zephyr_project_key` | Jira project key | No | `"SW"` |
| `zephyr_folders` | JSON object mapping directory patterns to Zephyr folder names | No | `"{}"` |
| `zephyr_default_folder` | Default Zephyr folder name if no pattern matches | No | `""` |
| `zephyr_labels` | Comma-separated labels to add to test cases | No | `"e2e,playwright,automated"` |
| `shared_test_dir` | Directory containing shared test files | No | `""` |

#### Secrets

| Secret | Description | Required |
|--------|-------------|----------|
| `ZEPHYR_TOKEN` | Zephyr Scale API token | Yes |
| `AUTH_TOKEN` | JFrog Artifactory auth token | No |
| `REGISTRY` | JFrog Artifactory npm registry URL | No |

### zephyr-report-results

Reusable workflow for reporting E2E test execution results to Zephyr Scale. This workflow parses JUnit XML reports and creates test executions in Zephyr.

#### Usage

```yaml
name: Report Test Results

on:
  workflow_run:
    workflows: ["E2E Tests"]
    types:
      - completed

jobs:
  report:
    uses: tetrascience/ts-ci-cd-lib/.github/workflows/zephyr-report-results.yml@main
    with:
      junit_paths: "test-results/junit.xml"
      zephyr_cycle_name_prefix: "E2E"
    secrets:
      ZEPHYR_TOKEN: ${{ secrets.ZEPHYR_TOKEN }}
```

#### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `node_version` | Node.js version | No | `"20"` |
| `junit_paths` | Comma-separated list of JUnit XML file paths | Yes | - |
| `zephyr_project_key` | Jira project key | No | `"SW"` |
| `zephyr_test_cycle_key` | Existing test cycle key (creates new if not set) | No | `""` |
| `zephyr_cycle_name_prefix` | Prefix for auto-generated cycle names | No | `"E2E"` |
| `zephyr_folders` | JSON object mapping directory patterns to app labels | No | `"{}"` |
| `zephyr_labels` | Comma-separated labels for test cycles | No | `"e2e,playwright,automated"` |
| `os` | Operating system for test environment | No | `"ubuntu-latest"` |

#### Secrets

| Secret | Description | Required |
|--------|-------------|----------|
| `ZEPHYR_TOKEN` | Zephyr Scale API token | Yes |

## Scripts

The following scripts are available in the `scripts/zephyr/` directory for direct use or customization.

### sync-zephyr.ts

TypeScript script that syncs Playwright/Storybook tests to Zephyr Scale. It scans test files, creates test cases, and updates files with Zephyr IDs.

#### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `ZEPHYR_TOKEN` | Zephyr Scale API token | Yes | - |
| `ZEPHYR_PROJECT_KEY` | Jira project key | No | `"SW"` |
| `TEST_DIRS` | Comma-separated test directories | Yes | - |
| `TEST_FILE_PATTERN` | File pattern to match | No | `".spec.ts"` |
| `ZEPHYR_FOLDERS` | JSON mapping of patterns to folder names | No | `"{}"` |
| `ZEPHYR_DEFAULT_FOLDER` | Default folder name | No | `""` |
| `ZEPHYR_LABELS` | Comma-separated labels | No | `"e2e,playwright,automated"` |
| `SHARED_TEST_DIR` | Shared test directory | No | `""` |

#### Direct Usage

```bash
ZEPHYR_TOKEN=your_token \
TEST_DIRS=packages/my-app/tests/e2e \
ZEPHYR_FOLDERS='{"my-app": "My App Tests"}' \
tsx scripts/zephyr/sync-zephyr.ts
```

### report-zephyr-results.ts

TypeScript script that reports test execution results to Zephyr Scale by parsing JUnit XML reports.

#### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `ZEPHYR_TOKEN` | Zephyr Scale API token | Yes | - |
| `ZEPHYR_PROJECT_KEY` | Jira project key | No | `"SW"` |
| `JUNIT_PATHS` | Comma-separated JUnit XML paths | Yes | - |
| `ZEPHYR_TEST_CYCLE_KEY` | Existing test cycle key | No | Creates new |
| `ZEPHYR_CYCLE_NAME_PREFIX` | Cycle name prefix | No | `"E2E"` |
| `ZEPHYR_FOLDERS` | JSON mapping for app labels | No | `"{}"` |
| `ZEPHYR_LABELS` | Comma-separated labels | No | `"e2e,playwright,automated"` |
| `GITHUB_RUN_ID` | GitHub Actions run ID | No | `"local"` |
| `PR_NUMBER` | Pull request number | No | `"n/a"` |
| `OS` | Operating system | No | `"local"` |

#### Direct Usage

```bash
ZEPHYR_TOKEN=your_token \
JUNIT_PATHS=test-results/junit.xml \
tsx scripts/zephyr/report-zephyr-results.ts
```
