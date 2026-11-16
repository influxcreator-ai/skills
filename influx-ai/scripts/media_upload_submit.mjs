#!/usr/bin/env node
import { isMain, runCli } from './_media_upload_cli.mjs';
export { inspectFile } from './_media_upload_client.mjs';
export async function main(options) { return runCli('submit', options); }
if (isMain(import.meta.url)) process.exitCode = await main();
