# ts-ci-cd-lib <!-- omit in toc -->

Reusable CI/CD workflows for TetraScience repositories.

## Table of Contents <!-- omit in toc -->

- [Workflows](#workflows)
  - [publish-npm-package](#publish-npm-package)

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
