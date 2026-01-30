#!/usr/bin/env tsx
/**
 * Sync Playwright/Storybook e2e tests to Zephyr Scale
 *
 * This script:
 * 1. Finds all test files in configured directories
 * 2. Parses tests that don't have Zephyr IDs
 * 3. Creates test cases in Zephyr Scale (organized in folders)
 * 4. Updates test files with assigned Zephyr IDs
 *
 * Environment Variables:
 *   ZEPHYR_TOKEN - Zephyr Scale API token (required)
 *   ZEPHYR_PROJECT_KEY - Jira project key (default: 'SW')
 *   TEST_DIRS - Comma-separated list of test directories to scan
 *   TEST_FILE_PATTERN - File pattern to match (default: '.spec.ts')
 *   ZEPHYR_FOLDERS - JSON object mapping directory patterns to folder names
 *                    e.g., '{"data-sync-utility": "Data Sync Utility"}'
 *   ZEPHYR_DEFAULT_FOLDER - Default folder name if no pattern matches
 *   ZEPHYR_LABELS - Comma-separated labels (default: 'e2e,playwright,automated')
 *   SHARED_TEST_DIR - Directory containing shared test files (optional)
 */

import fs from 'fs';
import path from 'path';

// Types
interface TestCase {
  filePath: string;
  lineNumber: number;
  testName: string;
  description: string;
  describeBlock: string | null;
  hasZephyrId: boolean;
  existingId?: string;
  isFromShared?: boolean;
  sharedFilePath?: string;
}

interface ZephyrFolder {
  id: string;
  name: string;
}

interface FolderCache {
  [key: string]: string | null;
}

interface ZephyrTestCase {
  key: string;
  name: string;
}

interface FolderMapping {
  [pattern: string]: string;
}

// Configuration from environment variables
const ZEPHYR_BASE_URL = 'https://api.zephyrscale.smartbear.com/v2';
const ZEPHYR_TOKEN = process.env.ZEPHYR_TOKEN;
const PROJECT_KEY = process.env.ZEPHYR_PROJECT_KEY || 'SW';
const TEST_DIRS = process.env.TEST_DIRS?.split(',').map(d => d.trim()).filter(Boolean) || [];
const TEST_FILE_PATTERN = process.env.TEST_FILE_PATTERN || '.spec.ts';
const ZEPHYR_LABELS = process.env.ZEPHYR_LABELS?.split(',').map(l => l.trim()).filter(Boolean) 
  || ['e2e', 'playwright', 'automated'];
const ZEPHYR_DEFAULT_FOLDER = process.env.ZEPHYR_DEFAULT_FOLDER || '';
const SHARED_TEST_DIR = process.env.SHARED_TEST_DIR || '';

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

// Cache for folder IDs
let folderIdCache: FolderCache = {};

// Validate config
if (!ZEPHYR_TOKEN) {
  console.error('[ERROR] ZEPHYR_TOKEN is required');
  process.exit(1);
}

if (TEST_DIRS.length === 0) {
  console.error('[ERROR] TEST_DIRS is required (comma-separated list of test directories)');
  process.exit(1);
}

/**
 * Find all test files in provided directories
 */
function findTestFiles(): string[] {
  const testFiles: string[] = [];

  for (const dir of TEST_DIRS) {
    const fullPath = path.join(process.cwd(), dir);

    if (!fs.existsSync(fullPath)) {
      console.warn(`[WARN] Directory not found: ${dir}`);
      continue;
    }

    const files = fs.readdirSync(fullPath);
    for (const file of files) {
      if (file.endsWith(TEST_FILE_PATTERN)) {
        testFiles.push(path.join(fullPath, file));
      }
    }
  }

  return testFiles;
}

/**
 * Parse test file to extract tests
 */
function parseTestFile(filePath: string, content: string): TestCase[] {
  const tests: TestCase[] = [];
  const lines = content.split('\n');
  let currentDescribe: string | null = null;

  const testPattern = /test\('(.+?)'/;
  const describePattern = /test\.describe\('(.+?)'/;
  const zephyrIdPattern = /\[(.+?)\]\s*(.+)/;

  lines.forEach((line, index) => {
    const describeMatch = line.match(describePattern);
    if (describeMatch) {
      currentDescribe = describeMatch[1];
      return;
    }

    const testMatch = line.match(testPattern);
    if (testMatch) {
      const testName = testMatch[1];
      const zephyrMatch = testName.match(zephyrIdPattern);

      if (zephyrMatch) {
        tests.push({
          filePath,
          lineNumber: index + 1,
          testName,
          description: zephyrMatch[2],
          describeBlock: currentDescribe,
          hasZephyrId: true,
          existingId: zephyrMatch[1],
        });
      } else {
        tests.push({
          filePath,
          lineNumber: index + 1,
          testName,
          description: testName,
          describeBlock: currentDescribe,
          hasZephyrId: false,
        });
      }
    }
  });

  return tests;
}

/**
 * Parse shared test file to extract test definitions
 */
function parseSharedTestFile(
  callingFilePath: string,
  sharedFilePath: string,
  content: string,
  describeBlock: string | null
): TestCase[] {
  const tests: TestCase[] = [];
  const lines = content.split('\n');

  const testPattern = /test\('(.+?)'/;
  const zephyrIdPattern = /\[(.+?)\]\s*(.+)/;

  lines.forEach((line, index) => {
    const testMatch = line.match(testPattern);

    if (testMatch) {
      const testName = testMatch[1];
      const zephyrMatch = testName.match(zephyrIdPattern);

      if (zephyrMatch) {
        tests.push({
          filePath: callingFilePath,
          sharedFilePath,
          lineNumber: index + 1,
          testName,
          description: zephyrMatch[2],
          describeBlock,
          hasZephyrId: true,
          existingId: zephyrMatch[1],
          isFromShared: true,
        });
      } else {
        tests.push({
          filePath: callingFilePath,
          sharedFilePath,
          lineNumber: index + 1,
          testName,
          description: testName,
          describeBlock,
          hasZephyrId: false,
          isFromShared: true,
        });
      }
    }
  });

  return tests;
}

/**
 * Get or create folders in Zephyr
 */
async function getFolders(): Promise<FolderCache> {
  if (Object.keys(folderIdCache).length > 0) {
    return folderIdCache;
  }

  const url = `${ZEPHYR_BASE_URL}/folders?projectKey=${PROJECT_KEY}&folderType=TEST_CASE&maxResults=100`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${ZEPHYR_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    console.warn('Could not fetch folders, will create new folders');
    return {};
  }

  const data = await response.json();
  const folders = data.values || [];

  // Find existing folders based on FOLDER_MAPPING
  for (const [pattern, folderName] of Object.entries(FOLDER_MAPPING)) {
    const existingFolder = folders.find((f: ZephyrFolder) => f.name === folderName);
    if (existingFolder) {
      folderIdCache[pattern] = existingFolder.id;
    } else {
      // Create folder if it doesn't exist
      try {
        const newFolder = await createFolder(folderName);
        folderIdCache[pattern] = newFolder.id;
        console.log(`[INFO] Created folder: ${folderName}`);
      } catch (error: any) {
        console.warn(`[WARN] Could not create folder ${folderName}:`, error.message);
        folderIdCache[pattern] = null;
      }
    }
  }

  return folderIdCache;
}

/**
 * Create a folder in Zephyr
 */
async function createFolder(folderName: string): Promise<ZephyrFolder> {
  const url = `${ZEPHYR_BASE_URL}/folders`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ZEPHYR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      projectKey: PROJECT_KEY,
      name: folderName,
      folderType: 'TEST_CASE',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create folder: ${response.status} ${errorText}`);
  }

  return await response.json();
}

/**
 * Determine folder ID from file path based on FOLDER_MAPPING
 */
async function getFolderId(filePath: string): Promise<string | null> {
  const folders = await getFolders();
  const normalizedPath = filePath.replace(/\\/g, '/');

  for (const [pattern, folderId] of Object.entries(folders)) {
    if (normalizedPath.includes(pattern)) {
      return folderId;
    }
  }

  // Return default folder ID if configured
  if (ZEPHYR_DEFAULT_FOLDER && folders[ZEPHYR_DEFAULT_FOLDER]) {
    return folders[ZEPHYR_DEFAULT_FOLDER];
  }

  return null;
}

/**
 * Get app label from file path based on FOLDER_MAPPING
 */
function getAppLabel(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');

  for (const pattern of Object.keys(FOLDER_MAPPING)) {
    if (normalizedPath.includes(pattern)) {
      return pattern.replace(/-/g, '_').toUpperCase();
    }
  }

  return 'E2E';
}

/**
 * Create test case in Zephyr
 */
async function createTestCase(
  testName: string,
  objective: string,
  folderId: string | null,
  appLabel: string
): Promise<ZephyrTestCase> {
  const url = `${ZEPHYR_BASE_URL}/testcases`;

  const body: {
    projectKey: string;
    name: string;
    objective: string;
    labels: string[];
    folderId?: string;
  } = {
    projectKey: PROJECT_KEY,
    name: testName,
    objective,
    labels: [...ZEPHYR_LABELS, appLabel],
  };

  if (folderId) {
    body.folderId = folderId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ZEPHYR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create test case: ${response.status} ${errorText}`);
  }

  return await response.json();
}

/**
 * Update test file with Zephyr ID
 */
function updateTestFile(
  filePath: string,
  lineNumber: number,
  oldTestName: string,
  zephyrKey: string
): boolean {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const line = lines[lineNumber - 1];

  const testPattern = /test\('(.+?)'/;
  const lineMatch = line.match(testPattern);
  if (!lineMatch) {
    console.log(`    [WARNING] Could not find test pattern in line ${lineNumber}`);
    return false;
  }

  const currentTestName = lineMatch[1];
  const zephyrIdPattern = /\[(.+?)\]\s*(.+)/;
  const match = currentTestName.match(zephyrIdPattern);

  let updatedLine;
  if (match) {
    // Test already has ID(s), append the new one
    const existingIds = match[1];
    const description = match[2];
    const newIds = `${existingIds},${zephyrKey}`;
    updatedLine = line
      .replace(`test('${currentTestName}',`, `test('[${newIds}] ${description}',`)
      .replace(`test("${currentTestName}",`, `test("[${newIds}] ${description}",`);
  } else {
    // Test has no ID, add it
    updatedLine = line
      .replace(`test('${currentTestName}',`, `test('[${zephyrKey}] ${currentTestName}',`)
      .replace(`test("${currentTestName}",`, `test("[${zephyrKey}] ${currentTestName}",`);
  }

  const changed = line !== updatedLine;

  if (changed) {
    console.log(`    Before: ${line.trim()}`);
    console.log(`    After:  ${updatedLine.trim()}`);
    lines[lineNumber - 1] = updatedLine;
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return true;
  } else {
    console.log(`    [WARNING] No change made - pattern might not have matched`);
    return false;
  }
}

/**
 * Generate test objective
 */
function generateObjective(test: TestCase): string {
  const parts: string[] = [];

  if (test.describeBlock) {
    parts.push(`Feature: ${test.describeBlock}<br/>`);
  }

  parts.push(`Test: ${test.description}<br/>`);

  const relativePath = path.relative(process.cwd(), test.filePath);
  parts.push(`File: \`${relativePath}\`<br/>`);

  return parts.join('<br/>');
}

/**
 * Main sync function
 */
async function main(): Promise<void> {
  console.log('[INFO] Scanning for test files...\n');
  console.log(`[INFO] Configuration:`);
  console.log(`  Project Key: ${PROJECT_KEY}`);
  console.log(`  Test Dirs: ${TEST_DIRS.join(', ')}`);
  console.log(`  File Pattern: ${TEST_FILE_PATTERN}`);
  console.log(`  Labels: ${ZEPHYR_LABELS.join(', ')}`);
  console.log(`  Folder Mapping: ${JSON.stringify(FOLDER_MAPPING)}\n`);

  const testFiles = findTestFiles();

  console.log(`[INFO] Found ${testFiles.length} test file(s):`);
  testFiles.forEach(file => {
    const relativePath = path.relative(process.cwd(), file);
    console.log(`  - ${relativePath}`);
  });
  console.log('');

  // Parse all test files
  const allTests: TestCase[] = [];
  console.log('[INFO] Parsing test files...\n');
  for (const file of testFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const tests = parseTestFile(file, content);
    const relativePath = path.relative(process.cwd(), file);
    console.log(`  ${relativePath}: found ${tests.length} test(s)`);
    tests.forEach(test => {
      const source = test.isFromShared ? `(from ${path.basename(test.sharedFilePath || '')})` : '';
      const idStatus = test.hasZephyrId ? `[HAS ID: ${test.existingId}]` : '[NEEDS ID]';
      console.log(`    - ${idStatus} ${test.description} ${source}`);
    });
    allTests.push(...tests);
  }
  console.log('');

  // Filter tests that need Zephyr IDs
  const testsNeedingIds = allTests.filter((t) => !t.hasZephyrId);
  const testsWithIds = allTests.filter((t) => t.hasZephyrId);

  console.log(`[INFO] Tests with Zephyr IDs: ${testsWithIds.length}`);
  console.log(`[INFO] Tests needing Zephyr IDs: ${testsNeedingIds.length}\n`);

  if (testsNeedingIds.length === 0) {
    console.log('[INFO] All tests already have Zephyr IDs!\n');
    return;
  }

  console.log(`[INFO] Creating ${testsNeedingIds.length} test case(s) in Zephyr...\n`);

  const processedSharedTests = new Map<string, boolean>();
  let successCount = 0;
  let failCount = 0;
  let updateCount = 0;

  for (const test of testsNeedingIds) {
    console.log(`\n[PROCESSING] ${test.description}`);
    console.log(`  File: ${path.relative(process.cwd(), test.filePath)}`);
    if (test.isFromShared) {
      console.log(`  Shared: ${path.relative(process.cwd(), test.sharedFilePath || '')}`);
    }
    console.log(`  Line: ${test.lineNumber}`);

    try {
      const folderId = await getFolderId(test.filePath);
      const appLabel = getAppLabel(test.filePath);

      // For shared tests, check if we've already processed this test+line
      if (test.isFromShared) {
        const testKey = `${test.sharedFilePath}:${test.lineNumber}:${appLabel}`;
        console.log(`  App: ${appLabel}`);
        console.log(`  Dedup Key: ${testKey}`);

        if (processedSharedTests.has(testKey)) {
          console.log(`  [SKIP] Already processed for ${appLabel}`);
          continue;
        }
        processedSharedTests.set(testKey, true);
      }

      const objective = generateObjective(test);

      console.log(`  [API] Creating test case in Zephyr...`);
      const result = await createTestCase(test.description, objective, folderId, appLabel);

      console.log(`  [SUCCESS] Created ${result.key}`);

      // Update file with Zephyr ID
      const fileToUpdate = test.sharedFilePath || test.filePath;
      const relativePath = path.relative(process.cwd(), fileToUpdate);

      console.log(`  [UPDATE] Updating ${relativePath}:${test.lineNumber} with ${result.key}`);
      const wasUpdated = updateTestFile(fileToUpdate, test.lineNumber, test.testName, result.key);

      if (wasUpdated) {
        updateCount++;
        console.log(`  [UPDATE] ✓ File updated successfully`);
      } else {
        console.log(`  [UPDATE] ✗ File update failed or no change`);
      }

      successCount++;
    } catch (error: any) {
      console.error(`  [ERROR] ${error.message}`);
      failCount++;
    }
  }

  console.log('\n=====================================');
  console.log('[INFO] Sync complete!');
  console.log(`[SUCCESS] Test cases created: ${successCount}`);
  console.log(`[SUCCESS] Files updated: ${updateCount}`);
  if (failCount > 0) {
    console.log(`[ERROR] Failed: ${failCount}`);
    process.exit(1);
  }
}

// Run the script
main().catch((error) => {
  console.error('[ERROR] Fatal error:', error);
  process.exit(1);
});

