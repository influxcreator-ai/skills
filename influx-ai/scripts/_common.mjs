import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// True when the module at `url` (pass import.meta.url) is the script started from the command line,
// false when it is imported by another module. Entry scripts use it so that importing them has no side effects.
export function isMain(url) { return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === url; }

// Raw JSON text for the discovery scripts: either the single inline argument, or `--input-file <path>` (UTF-8, BOM allowed),
// matching the other tool scripts. Throws on any other argument shape or an unreadable file; callers turn that into their input error.
export function readJsonArgument(args = process.argv.slice(2)) {
  if (args.length === 2 && args[0] === '--input-file') return readFileSync(args[1], 'utf8').replace(/^\uFEFF/, '');
  if (args.length === 1 && !args[0].startsWith('--')) return args[0];
  throw new Error('invalid arguments');
}
