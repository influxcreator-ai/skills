#!/usr/bin/env node
import { isMain, runCli } from './_brief_analysis_cli.mjs';
export { prepareRequest } from './_brief_analysis_client.mjs';
export async function main(options) { return runCli('edit', options); }
if (isMain(import.meta.url)) process.exitCode = await main();
