import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// True when the module at `url` (pass import.meta.url) is the script started from the command line,
// false when it is imported by another module. Entry scripts use it so that importing them has no side effects.
export function isMain(url) { return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === url; }
