#!/usr/bin/env tsx
/**
 * Report Playwright/Storybook e2e test execution results to Zephyr Scale
 *
 * This script:
 * 1. Parses JUnit XML reports from test runs
 * 2. Extracts Zephyr test case IDs from test names
 * 3. Creates a test cycle in Zephyr Scale
 * 4. Reports test execution results (pass/fail) for each test
 *
 * Environment Variables:
 *   ZEPHYR_TOKEN - Zephyr Scale API token (required)
 *   ZEPHYR_PROJECT_KEY - Jira project key (default: 'SW')
 *   JUNIT_PATHS - Comma-separated list of JUnit XML file paths
 *   ZEPHYR_TEST_CYCLE_KEY - Existing test cycle key to use (optional, creates new if not set)
 *   ZEPHYR_CYCLE_NAME_PREFIX - Prefix for auto-generated cycle names (default: 'E2E')
 *   ZEPHYR_FOLDERS - JSON object mapping directory patterns to app labels
 *   GITHUB_RUN_ID - GitHub Actions run ID (optional)
 *   PR_NUMBER - Pull request number (optional)
 *   OS - Operating system (optional)
 *   ZEPHYR_LABELS - Comma-separated labels for test cycles (default: 'e2e,playwright,automated')
 */

import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { parseString } from 'xml2js';
import { promisify } from 'util';

// Wrap parseString in a promise utility
const parseXml = promisify(parseString);

// Types
interface TestResult {
  testName: string;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  errorMessage?: string;
  zephyrIds: string[];
  appLabel: string;
}

interface ZephyrTestCycle {
  key: string;
}

interface ZephyrTestExecution {
  key: string;
}

interface JUnitTestCase {
  $: {
    name: string;
    classname: string;
    time: string;
  };
  failure?: Array<{
    _: string;
    $: { message: string; type: string };
  }>;
  skipped?: Array<Record<string, unknown>>;
  error?: Array<{
    _: string;
    $: { message: string; type: string };
  }>;
}

interface JUnitTestSuite {
  $: {
    name: string;
    tests: string;
    failures: string;
    skipped?: string;
    time: string;
  };
  testcase: JUnitTestCase[];
}

interface ParsedJUnitXml {
  testsuites?: {
    testsuite?: JUnitTestSuite | JUnitTestSuite[];
  };
}

interface TestExecutionBody {
  projectKey: string;
  testCaseKey: string;
  testCycleKey: string;
  statusName: string;
  environment: string;
  executionTime: number;
  actualEndDate: string;
  comment?: string;
}

interface FolderMapping {
  [pattern: string]: string;
}

// Configuration from environment variables
const ZEPHYR_BASE_URL = 'https://api.zephyrscale.smartbear.com/v2';
const ZEPHYR_TOKEN = process.env.ZEPHYR_TOKEN;
const ZEPHYR_TEST_CYCLE_KEY = process.env.ZEPHYR_TEST_CYCLE_KEY;
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID || 'local';
const PR_NUMBER = process.env.PR_NUMBER || 'n/a';
const OS = process.env.OS || 'local';
const PROJECT_KEY = process.env.ZEPHYR_PROJECT_KEY || 'SW';
const JUNIT_PATHS = process.env.JUNIT_PATHS?.split(',').map(p => p.trim()).filter(Boolean) || [];
const CYCLE_NAME_PREFIX = process.env.ZEPHYR_CYCLE_NAME_PREFIX || 'E2E';
const ZEPHYR_LABELS = process.env.ZEPHYR_LABELS?.split(',').map(l => l.trim()).filter(Boolean) 
  || ['e2e', 'playwright', 'automated'];

// Parse folder mapping from JSON
let FOLDER_MAPPING: FolderMapping = {};
try {
  if (process.env.ZEPHYR_FOLDERS) {
    FOLDER_MAPPING = JSON.parse(process.env.ZEPHYR_FOLDERS);
  }
} catch (e) {
  console.error('[ERROR] Failed to parse ZEPHYR_FOLDERS JSON:', e);
  process.exit(1);
}

// Validate config
if (!ZEPHYR_TOKEN) {
  console.error('[ERROR] ZEPHYR_TOKEN environment variable is required');
  process.exit(1);
}

if (JUNIT_PATHS.length === 0) {
  console.error('[ERROR] JUNIT_PATHS is required (comma-separated list of JUnit XML paths)');
  process.exit(1);
}

/**
 * Get existing JUnit XML result files
 */
function getJUnitFiles(): string[] {
  return JUNIT_PATHS
    .map((p) => join(process.cwd(), p))
    .filter(existsSync);
}

/**
 * Determine app label from file path based on FOLDER_MAPPING
 */
function determineAppLabel(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  for (const pattern of Object.keys(FOLDER_MAPPING)) {
    if (normalizedPath.includes(pattern)) {
      return pattern.replace(/-/g, '_').toUpperCase();
    }
  }
  
  return 'E2E';
}

/**
 * Extract Zephyr test case IDs from test name
 * Supports formats like: [SW-T18] or [SW-T18,SW-T19]
 */
function extractZephyrIds(testName: string): string[] {
  const match = testName.match(/\[([^\]]+)\]/);
  if (!match) {
    return [];
  }

  const idsString = match[1];
  return idsString
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.startsWith(`${PROJECT_KEY}-T`));
}

/**
 * Parse JUnit XML file to extract test results
 */
async function parseJUnitFile(filePath: string): Promise<TestResult[]> {
  const content = readFileSync(filePath, 'utf-8');
  const results: TestResult[] = [];

  try {
    const parsed = (await parseXml(content)) as ParsedJUnitXml;

    if (!parsed.testsuites || !parsed.testsuites.testsuite) {
      console.warn(`[WARN] No test suites found in ${filePath}`);
      return results;
    }

    const testsuites = Array.isArray(parsed.testsuites.testsuite)
      ? parsed.testsuites.testsuite
      : [parsed.testsuites.testsuite];

    for (const suite of testsuites as JUnitTestSuite[]) {
      const testcases = Array.isArray(suite.testcase) ? suite.testcase : [suite.testcase];

      for (const testcase of testcases) {
        if (!testcase) continue;

        const testName = testcase.$.name;
        const duration = Math.round(parseFloat(testcase.$.time) * 1000);

        let status: 'passed' | 'failed' | 'skipped' = 'passed';
        let errorMessage: string | undefined;

        if (testcase.failure && testcase.failure.length > 0) {
          status = 'failed';
          errorMessage = testcase.failure[0].$.message || testcase.failure[0]._;
        } else if (testcase.error && testcase.error.length > 0) {
          status = 'failed';
          errorMessage = testcase.error[0].$.message || testcase.error[0]._;
        } else if (testcase.skipped && testcase.skipped.length > 0) {
          status = 'skipped';
        }

        const zephyrIds = extractZephyrIds(testName);
        const appLabel = determineAppLabel(filePath);

        results.push({
          testName,
          status,
          duration,
          errorMessage,
          zephyrIds,
          appLabel,
        });
      }
    }
  } catch (error) {
    console.error(`[ERROR] Failed to parse ${filePath}:`, error instanceof Error ? error.message : String(error));
  }

  return results;
}

/**
 * Map Playwright test status to Zephyr status name
 */
function mapStatusToZephyr(status: 'passed' | 'failed' | 'skipped'): string {
  return { passed: 'Pass', failed: 'Fail', skipped: 'Not Executed' }[status];
}

/**
 * Create a test cycle in Zephyr
 */
async function createTestCycle(
  name: string,
  description: string,
  labels: string[]
): Promise<ZephyrTestCycle> {
  const url = `${ZEPHYR_BASE_URL}/testcycles`;

  const now = new Date();
  const endDate = new Date(now.getTime() + 10 * 60 * 1000);

  const body = {
    projectKey: PROJECT_KEY,
    name,
    description,
    plannedStartDate: now.toISOString(),
    plannedEndDate: endDate.toISOString(),
    statusName: 'Done',
    labels,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ZEPHYR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create test cycle: ${response.status} ${errorText}`);
  }

  return await response.json();
}

/**
 * Create a test execution in Zephyr
 */
async function createTestExecution(
  testCaseKey: string,
  testCycleKey: string,
  status: string,
  executionTime: number,
  comment?: string
): Promise<ZephyrTestExecution> {
  const url = `${ZEPHYR_BASE_URL}/testexecutions`;

  const body: TestExecutionBody = {
    projectKey: PROJECT_KEY,
    testCaseKey,
    testCycleKey,
    statusName: status,
    environment: OS,
    executionTime,
    actualEndDate: new Date().toISOString(),
  };

  if (comment) {
    body.comment = comment.substring(0, 1000);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ZEPHYR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to create test execution for ${testCaseKey}: ${response.status} ${errorText}`
    );
  }

  return await response.json();
}

/**
 * Main function to orchestrate reporting
 */
async function main(): Promise<void> {
  console.log('[INFO] Zephyr Scale Test Results Reporter\n');
  console.log('[INFO] Configuration:');
  console.log(`  Project Key: ${PROJECT_KEY}`);
  console.log(`  JUnit Paths: ${JUNIT_PATHS.join(', ')}`);
  console.log(`  Cycle Name Prefix: ${CYCLE_NAME_PREFIX}`);
  console.log(`  Labels: ${ZEPHYR_LABELS.join(', ')}`);
  console.log(`  GitHub Run ID: ${GITHUB_RUN_ID}`);
  console.log(`  PR Number: ${PR_NUMBER}`);
  console.log(`  OS: ${OS}`);
  if (ZEPHYR_TEST_CYCLE_KEY) {
    console.log(`  Using existing cycle: ${ZEPHYR_TEST_CYCLE_KEY}`);
  }
  console.log('');

  // Find JUnit XML files
  const junitFiles = getJUnitFiles();

  if (junitFiles.length === 0) {
    console.warn('[WARN] No JUnit XML files found. Paths checked:');
    JUNIT_PATHS.forEach((p) => console.warn(`  - ${p}`));
    console.log('[INFO] This is expected if tests were skipped or not run.');
    return;
  }

  console.log(`[INFO] Found ${junitFiles.length} JUnit XML file(s):`);
  junitFiles.forEach((file) => {
    console.log(`  - ${relative(process.cwd(), file)}`);
  });
  console.log('');

  // Parse all JUnit files
  const allResults: TestResult[] = [];
  for (const file of junitFiles) {
    console.log(`[PARSE] Parsing ${relative(process.cwd(), file)}...`);
    const results = await parseJUnitFile(file);
    console.log(`  Found ${results.length} test(s)`);
    allResults.push(...results);
  }
  console.log('');

  // Filter results that have Zephyr IDs
  const resultsWithIds = allResults.filter((r) => r.zephyrIds.length > 0);
  const resultsWithoutIds = allResults.filter((r) => r.zephyrIds.length === 0);

  console.log(`[INFO] Total tests: ${allResults.length}`);
  console.log(`[INFO] Tests with Zephyr IDs: ${resultsWithIds.length}`);
  console.log(`[INFO] Tests without Zephyr IDs: ${resultsWithoutIds.length}`);

  if (resultsWithoutIds.length > 0) {
    console.log('\n[WARN] Tests without Zephyr IDs (will not be reported):');
    resultsWithoutIds.forEach((r) => {
      console.log(`  - ${r.testName}`);
    });
  }

  if (resultsWithIds.length === 0) {
    console.log('\n[INFO] No tests with Zephyr IDs to report.');
    return;
  }

  // Group results by app label for cycle organization
  const resultsByApp = new Map<string, TestResult[]>();
  for (const result of resultsWithIds) {
    const app = result.appLabel;
    if (!resultsByApp.has(app)) {
      resultsByApp.set(app, []);
    }
    resultsByApp.get(app)!.push(result);
  }

  // Create test cycle or use existing one
  let testCycleKey = ZEPHYR_TEST_CYCLE_KEY;

  if (!testCycleKey) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const apps = Array.from(resultsByApp.keys()).join(', ');
    const cycleName = `${CYCLE_NAME_PREFIX} Test Run - ${timestamp}`;
    const description = `Automated ${CYCLE_NAME_PREFIX} test execution\n\nApps: ${apps}\nGitHub Run: ${GITHUB_RUN_ID}\nPR: ${PR_NUMBER}\nOS: ${OS}`;

    console.log(`\n[API] Creating test cycle: ${cycleName}`);
    try {
      const cycle = await createTestCycle(cycleName, description, ZEPHYR_LABELS);
      testCycleKey = cycle.key;
      console.log(`[SUCCESS] Created test cycle: ${testCycleKey}`);
    } catch (error) {
      console.error('[ERROR] Failed to create test cycle:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else {
    console.log(`\n[INFO] Using existing test cycle: ${testCycleKey}`);
  }

  // Report test executions
  console.log(`\n[INFO] Reporting ${resultsWithIds.length} test execution(s)...\n`);

  let successCount = 0;
  let failCount = 0;
  const reportedIds = new Set<string>();

  for (const result of resultsWithIds) {
    for (const zephyrId of result.zephyrIds) {
      // Skip if we've already reported this test case in this run
      const reportKey = `${zephyrId}-${testCycleKey}`;
      if (reportedIds.has(reportKey)) {
        console.log(`[SKIP] ${zephyrId} - already reported in this cycle`);
        continue;
      }
      reportedIds.add(reportKey);

      const zephyrStatus = mapStatusToZephyr(result.status);
      const comment = result.errorMessage
        ? `Error: ${result.errorMessage}`
        : undefined;

      console.log(`[REPORT] ${zephyrId} - ${result.status} (${result.duration}ms)`);

      try {
        await createTestExecution(
          zephyrId,
          testCycleKey,
          zephyrStatus,
          result.duration,
          comment
        );
        console.log(`  [SUCCESS] Reported ${zephyrId}`);
        successCount++;
      } catch (error) {
        console.error(`  [ERROR] Failed to report ${zephyrId}:`, error instanceof Error ? error.message : String(error));
        failCount++;
      }
    }
  }

  // Summary
  console.log('\n=====================================');
  console.log('[INFO] Reporting complete!');
  console.log(`[INFO] Test Cycle: ${testCycleKey}`);
  console.log(`[SUCCESS] Executions reported: ${successCount}`);
  if (failCount > 0) {
    console.log(`[ERROR] Failed reports: ${failCount}`);
    process.exit(1);
  }

  // Status summary
  const passed = resultsWithIds.filter((r) => r.status === 'passed').length;
  const failed = resultsWithIds.filter((r) => r.status === 'failed').length;
  const skipped = resultsWithIds.filter((r) => r.status === 'skipped').length;

  console.log(`\n[SUMMARY] Pass: ${passed}, Fail: ${failed}, Skipped: ${skipped}`);
}

// Run the script
main().catch((error) => {
  console.error('[ERROR] Fatal error:', error);
  process.exit(1);
});
