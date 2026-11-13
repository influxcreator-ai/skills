#!/usr/bin/env node
import { isMain, runCli } from './_profile_tagging_cli.mjs';
export { prepareRequest } from './_profile_tagging_client.mjs';
export async function main(options) { return runCli('options', options); }
if (isMain(import.meta.url)) process.exitCode = await main();
