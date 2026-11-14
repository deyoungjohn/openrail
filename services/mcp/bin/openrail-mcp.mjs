#!/usr/bin/env node
import process from "node:process";
import { register } from "tsx/esm/api";

register();
const { runStdioServer } = await import("../src/index.ts");
await runStdioServer(process.argv.slice(2));
