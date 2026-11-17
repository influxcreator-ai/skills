#!/usr/bin/env node
import { isMain, runCli } from './_video_script_audit_cli.mjs';
export { prepareRequest } from './_video_script_audit_client.mjs';
export async function main(options) { return runCli('sessions_list', options); }
if (isMain(import.meta.url)) process.exitCode = await main();
