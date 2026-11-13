#!/usr/bin/env node
import { isMain, runCli } from './_video_monitor_cli.mjs';
export { prepareRequest } from './_video_monitor_client.mjs';
export async function main(options) { return runCli('list', options); }
if (isMain(import.meta.url)) process.exitCode = await main();
