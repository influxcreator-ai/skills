#!/usr/bin/env node
import { isMain, runCli } from './_competitor_tracking_cli.mjs';
export { prepareRequest } from './_competitor_tracking_client.mjs';
export async function main(options) { return runCli('create', options); }
if (isMain(import.meta.url)) process.exitCode = await main();
