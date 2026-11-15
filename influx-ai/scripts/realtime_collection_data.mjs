#!/usr/bin/env node
import { isMain, runCli } from './_realtime_collection_cli.mjs';
export { prepareRequest } from './_realtime_collection_client.mjs';
export async function main(options) { return runCli('data', options); }
if (isMain(import.meta.url)) process.exitCode = await main();
