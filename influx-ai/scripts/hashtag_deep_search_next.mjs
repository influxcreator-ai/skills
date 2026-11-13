#!/usr/bin/env node
import { isMain, runCli } from './_hashtag_deep_search_cli.mjs';
export { prepareRequest } from './_hashtag_deep_search_client.mjs';
export async function main(options) { return runCli('next', options); }
if (isMain(import.meta.url)) process.exitCode = await main();
