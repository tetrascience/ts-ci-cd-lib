---
created: 2026-03-23T16:00:50.356Z
updated: 2026-03-23T16:00:50.356Z
---

# ts-ci-cd-lib Repository Exploration - Complete Summary

## Exploration Status: COMPLETE
The thorough exploration of the ts-ci-cd-lib repository has been completed. All findings have been documented and analyzed in detail.

## Repository Overview
- **Location**: `/Users/DBoersma/coding/ts-ci-cd-lib/`
- **Type**: Reusable GitHub Actions workflows library for TetraScience repositories
- **Primary Purpose**: Provide standardized CI/CD workflows for npm publishing, E2E testing, and link checking

## Reusable Workflows Discovered

### 1. publish-npm-package.yml (211 lines)
**Purpose**: Multi-step workflow for publishing npm packages to JFrog Artifactory or public npm registry

**Key Features**:
- Supports prerelease versions with run_number and run_attempt suffixes
- OIDC trusted publishing for public npm registry
- Automatic package scope rewriting (@tetrascience → @tetrascience-npm)
- Conditional TypeScript build detection via tsconfig.json
- Version validation for non-prerelease versions
- Registry configuration handling (JFrog vs public npm)

**Input Parameters**:
- `node_version` (default: "20")
- `working_directory` (default: ".")
- `prerelease_tag` (default: "")
- `run_tests` (default: true)
- `publish_to_public_npm` (default: false)

**Secrets** (conditional):
- `AUTH_TOKEN` - JFrog authentication
- `REGISTRY` - JFrog npm registry URL
- `PUBLISH_REGISTRY` - Target registry URL (required)

**Notable Implementation Details**:
- Uses corepack for yarn management
- Conditional npm installation for OIDC when publishing to public
- Validates configuration safety before proceeding
- Handles both yarn and npm publish commands

### 2. e2e-codebuild.yml (355 lines)
**Purpose**: Enterprise E2E testing workflow with CodeBuild integration

**Architecture**: Three-job workflow with dependencies
1. **check-changes** - Detects service code changes via git diff against deploy_paths patterns
2. **deploy** - Pushes to environment branch and waits for deployment workflow
3. **e2e** - Invokes CodeBuild, streams CloudWatch logs, writes job summary

**Key Features**:
- Pattern-based change detection for conditional deployment
- AWS OIDC integration for temporary credentials
- Cross-repository checkout of infrastructure config (ts-cloudformation-service)
- Dynamic environment resolution from YAML infrastructure config via yq
- S3 source upload with selective directory exclusion
- CodeBuild environment variable injection
- CloudWatch log streaming and parsing
- Job summary generation with status emoji
- Timeout handling with automatic build termination

**Input Parameters**:
- `environment` (required) - Target environment (e.g., predev5, dev)
- `deploy_paths` (required) - Space-separated glob patterns for change detection
- `buildspec` (required) - Path to caller's buildspec.e2e.yml
- `deploy_workflow` (default: "ci.yml") - Workflow to wait on
- `image_override` (optional) - CodeBuild image override
- `compute_type_override` (optional) - CodeBuild compute type override
- `timeout_minutes` (default: 25) - Job timeout in minutes

**Secrets** (required):
- `JFROG_ARTIFACTORY_NPM_VIRTUAL_URL` - JFrog npm registry
- `JFROG_ARTIFACTORY_READ_NPM_AUTH` - JFrog credentials
- `GITHUB_PAT` - Personal access token for cross-repo access

**Environment Variables Passed to CodeBuild**:
- `E2E_ENVIRONMENT` - Environment name
- `E2E_BASE_URL` - API base URL
- `E2E_SERVICE_NAME` - Repository name (for SSM path)
- `JFROG_ARTIFACTORY_URL` - JFrog registry
- `JFROG_ARTIFACTORY_AUTH` - JFrog credentials

### 3. check-links.yml (35 lines)
**Purpose**: Simple link validation using lychee tool

**Key Features**:
- Minimalist reusable workflow pattern
- Caching mechanism with GitHub SHA-based keys
- Uses GITHUB_TOKEN for rate limiting

**Input Parameters**:
- `lychee_args` (default: "--cache --max-cache-age 1d .") - Tool arguments

**No Secrets Required**: Uses standard GITHUB_TOKEN

## Naming and Convention Patterns

### Naming Conventions
- Descriptive kebab-case: `publish-npm-package.yml`, `e2e-codebuild.yml`, `check-links.yml`
- Names reflect primary action (publish, run E2E, check)

### Input Patterns
- All inputs include `description` field
- Optional inputs declare `required: false` with `default` value
- Type variety: string, boolean, number
- Inputs clearly documented in README with tables

### Secrets Handling
- Conditional secret requirement via step `if` conditions
- Some secrets conditionally used based on feature flags
- Secrets documented in README with required/optional status

### Permissions Declaration
- `id-token: write` - For AWS OIDC
- `contents: read` - For repository checkout
- `pull-requests: write` - For PR interactions

### Job Dependencies
- Uses `needs` keyword for explicit dependencies
- Conditional execution with `if` statements
- Output passing between jobs via `steps.<id>.outputs`
- `always()` function for steps that should run regardless of job status

### Environment Variables
- Passed via `env` blocks with GitHub Actions context
- Environment-specific and step-specific scoping
- Secrets referenced via `${{ secrets.SECRET_NAME }}`

### Working Directory Management
- Can be set at job level via `defaults.run.working-directory`
- Can be overridden per-step
- Useful for monorepos or packages in subdirectories

## Consumption Pattern

### How Calling Repositories Use These Workflows

```yaml
uses: tetrascience/ts-ci-cd-lib/.github/workflows/<workflow-name>.yml@main
with:
  input_name: value
  another_input: another_value
secrets:
  SECRET_NAME: ${{ secrets.SECRET_VALUE }}
```

### Example from ts-lib-ui-kit
- Calling repos reference workflows with @main or @<version> tag
- Pass inputs as documented
- Provide required secrets from calling repo's GitHub Secrets
- Infrastructure dependencies managed by calling repo (e.g., AWS IAM roles, SSM parameters)

## Technical Architecture Details

### publish-npm-package.yml Flow
1. Checkout code
2. Setup Node.js and Corepack
3. Validate configuration (especially for public npm)
4. Install dependencies from configured registry
5. Conditional: Build TypeScript if tsconfig.json exists
6. Conditional: Run tests if run_tests is true
7. Version handling:
   - Non-prerelease: Validate git tag matches package.json version
   - Prerelease: Generate version with suffix and build metadata
8. Scope rewriting for public npm (if applicable)
9. Registry configuration for publishing
10. Publish with appropriate flags (provenance for public, dist-tag for prerelease)

### e2e-codebuild.yml Flow
1. Check if service code changed (git diff against patterns)
2. If changed: Deploy by pushing to environment branch and waiting for CI
3. Regardless of deploy: Run E2E via CodeBuild
   - Resolve environment config from CloudFormation infrastructure file
   - Configure AWS credentials via OIDC
   - Upload source code to S3
   - Trigger CodeBuild with environment variables
   - Stream CloudWatch logs
   - Generate job summary
   - Validate build success

### check-links.yml Flow
1. Checkout code
2. Restore lychee cache from previous runs
3. Run lychee link checker with provided arguments
4. Cache results for future runs

## Infrastructure Requirements

### e2e-codebuild.yml Infrastructure
- Shared CodeBuild project: `tdp-e2e` (deployed via ts-cloudformation-service)
- Infrastructure config file: `ts-cloudformation-service/infrastructure/tdp-e2e-environments.yml`
- AWS SSM parameters: `/tdp/e2e/{service-name}/auth-token`
- AWS IAM roles: `gha-tdp-e2e-{environment}` (for GitHub OIDC)
- S3 buckets: `tdp-e2e-source-{account-id}` (for source upload)
- CloudWatch log groups: Named by CodeBuild project

### publish-npm-package.yml Infrastructure
- GitHub environment: `artifactory-prod`
- JFrog Artifactory repository (optional, for private publishing)
- Public npm registry (optional, with OIDC support)

## No Existing Coverage Workflow
**Finding**: No coverage-related reusable workflow currently exists in ts-ci-cd-lib

**Architecture Implication**: Coverage workflows (if needed) would follow the same patterns as published workflows:
- Single responsibility workflow handling coverage reporting
- Inputs for thresholds, reporting format, etc.
- Secrets for coverage service APIs (e.g., Codecov, Coveralls)
- Output generation (badges, comments, etc.)

## Documentation
- **Primary Documentation**: `/Users/DBoersma/coding/ts-ci-cd-lib/README.md` (240 lines)
  - Usage examples for each workflow
  - Input/secret requirement tables
  - Infrastructure setup instructions
  - Prerelease publishing guidance
  - Link checking configuration examples

## Key Design Principles Observed

1. **Single Responsibility**: Each workflow handles one primary concern
2. **Flexibility**: Inputs allow customization without fork maintenance
3. **Safety**: Validation and conditional execution prevent common mistakes
4. **Transparency**: Job summaries and logs visible to developers
5. **Cost Control**: Conditional deployment and efficient resource usage
6. **Security**: OIDC for authentication, secret management, repository-specific SSM paths
7. **Reusability**: Shared infrastructure (CodeBuild, npm registry) across all calling repos

## Next Steps (Pending User Direction)

This exploration is complete. The repository contains:
- 3 fully-featured reusable workflows
- Clear naming and parameter conventions
- Comprehensive README documentation
- Complex infrastructure integration (CodeBuild, AWS OIDC, S3, CloudWatch)
- Simple and complex workflow examples

User guidance needed for:
1. Should a new coverage-related reusable workflow be designed and implemented?
2. Should existing ts-lib-ui-kit workflow implementations be examined in detail?
3. Are there architectural enhancements to existing workflows?
4. Should new features be added to existing workflows?

**Status**: READY FOR USER INPUT - No implementations should proceed without explicit user request.
