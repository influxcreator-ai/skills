#!/usr/bin/env node
import { isMain, runCli } from './_media_upload_cli.mjs';
export { prepareStatus } from './_media_upload_client.mjs';
export async function main(options) { return runCli('status', options); }
if (isMain(import.meta.url)) process.exitCode = await main();
