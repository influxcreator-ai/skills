#!/usr/bin/env node
// Generate or verify skill-manifest.json from local skill files.
// Adapted from creator-scraper-cv/scripts/generate_manifest.mjs.
// Differences: SHA-256 is computed over raw bytes (.gitattributes keeps influx-ai/** as -text),
// entries carry no url, and existing sync/purpose/self_excluded fields are preserved.
//
// Usage:
//   node scripts/generate_manifest.mjs                 write skill-manifest.json
//   node scripts/generate_manifest.mjs --dry-run       print the manifest, write nothing
//   node scripts/generate_manifest.mjs --check         exit 1 if the file list or hashes are stale
//   node scripts/generate_manifest.mjs --version 0.5.0 --note "Release note"

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillMetaPath = join(skillRoot, 'skill.json');
const manifestPath = join(skillRoot, 'skill-manifest.json');
const manifestName = 'skill-manifest.json';
// Local-only material that must never be listed (mirrors influx-ai/.gitignore and sync.exclude).
const excludedPathPrefixes = [
  '.git/', '.skill-backups/', 'node_modules/', 'local-requests/', 'scout-email-integration/',
  'private/', 'tmp/', 'temp/', '.cache/', 'coverage/', '.agents/', '.codex/', '.claude/',
];
const excludedPathNames = /^(\.DS_Store|Thumbs\.db|skills-lock\.json|\.env(\..*)?|.*\.(log|pem|key)|credentials.*|secrets.*)$/;

const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const byCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function parseArgs(argv) {
  const result = { notes: [], dryRun: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version') result.version = argv[++index];
    else if (arg === '--min-supported') result.minSupported = argv[++index];
    else if (arg === '--note') result.notes.push(argv[++index]);
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--check') result.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function assertSafeRelativePath(path) {
  const normalized = normalize(path).replaceAll('\\', '/');
  if (!normalized || isAbsolute(normalized) || normalized.startsWith('..') || normalized.includes('/../') || normalized === '.') {
    throw new Error(`Unsafe manifest file path: ${path}`);
  }
  return normalized;
}

function isExcludedPath(relativePath) {
  const normalized = assertSafeRelativePath(relativePath);
  return normalized === manifestName
    || excludedPathNames.test(normalized.split('/').pop())
    || excludedPathPrefixes.some((prefix) => normalized.startsWith(prefix) || `${normalized}/` === prefix);
}

function scanSkillFiles(root = skillRoot, prefix = '') {
  const paths = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = assertSafeRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (isExcludedPath(relativePath)) continue;
    if (entry.isDirectory()) paths.push(...scanSkillFiles(join(root, entry.name), relativePath));
    else if (entry.isFile()) paths.push(relativePath);
  }
  return paths.sort(byCodeUnit);
}

const sha256ForFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function buildManifest({ args, skillMeta, currentManifest }) {
  const version = args.version || skillMeta.version || currentManifest.latest_version;
  if (!version) throw new Error('Missing version. Set skill.json version or pass --version.');
  return {
    name: currentManifest.name || skillMeta.name,
    latest_version: version,
    min_supported_version: args.minSupported || currentManifest.min_supported_version || version,
    channel: skillMeta.channel || currentManifest.channel || 'stable',
    release_notes: args.notes.length > 0 ? args.notes : currentManifest.release_notes || [],
    sync: currentManifest.sync || { mode: 'mirror', delete_missing: true, managed_roots: ['.'], exclude: ['.skill-backups/**'] },
    files: scanSkillFiles().map((path) => ({ path, sha256: sha256ForFile(join(skillRoot, path)) })),
    ...(currentManifest.purpose ? { purpose: currentManifest.purpose } : {}),
    ...(currentManifest.self_excluded ? { self_excluded: currentManifest.self_excluded } : {}),
  };
}

function checkManifest(current, expected) {
  const failures = [];
  const listed = new Map((current.files || []).map((file) => [file.path, file.sha256]));
  for (const file of expected.files) {
    if (!listed.has(file.path)) failures.push(`missing from manifest: ${file.path}`);
    else if (listed.get(file.path) !== file.sha256) failures.push(`stale hash: ${file.path}`);
    listed.delete(file.path);
  }
  for (const path of listed.keys()) failures.push(`listed but not on disk: ${path}`);
  if (current.latest_version !== expected.latest_version) failures.push(`latest_version ${current.latest_version} != skill.json ${expected.latest_version}`);
  return failures;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const currentManifest = existsSync(manifestPath) ? readJSON(manifestPath) : {};
  const manifest = buildManifest({ args, skillMeta: readJSON(skillMetaPath), currentManifest });

  if (args.check) {
    const failures = checkManifest(currentManifest, manifest);
    console.log(JSON.stringify({ ok: failures.length === 0, file_count: manifest.files.length, failures }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
    return;
  }
  if (args.dryRun) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, manifest: manifestName, latest_version: manifest.latest_version, file_count: manifest.files.length }, null, 2));
}

main();
