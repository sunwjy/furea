import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

console.error(`furea ${version}: the installer is not implemented yet.`);
process.exitCode = 1;
