#!/usr/bin/env node
import process from "node:process";
import { register } from "tsx/esm/api";

register();
const { runCli } = await import("../src/index.ts");
const result = await runCli(process.argv.slice(2));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
