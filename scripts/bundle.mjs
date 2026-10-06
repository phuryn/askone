#!/usr/bin/env node
// Release mechanics that must not drift: one version everywhere, the bundle's
// SHA-256 in server.json, and (with --verify-release) the published asset
// matching it.
//   npm run bundle           check versions, pack askone.mcpb, write its hash
//   npm run verify-release   download the release asset and compare the hash
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { console.error(`✗ ${message}`); process.exit(1); };

const { version } = json("package.json");
const manifest = json("manifest.json");
const server = json("server.json");
const bundle = server.packages?.find((item) => item.registryType === "mcpb");
const expectedUrl = `https://github.com/phuryn/askone/releases/download/v${version}/askone.mcpb`;

if (manifest.version !== version) fail(`manifest.json is ${manifest.version}, package.json is ${version}`);
const lock = json("package-lock.json");
if (lock.version !== version || lock.packages?.[""]?.version !== version) fail(`package-lock.json is not ${version}; run npm install --package-lock-only`);
if (server.version !== version) fail(`server.json is ${server.version}, package.json is ${version}`);
if (bundle?.identifier !== expectedUrl) fail(`server.json's mcpb identifier should be ${expectedUrl}`);
const npmPackage = server.packages?.find((item) => item.registryType === "npm");
if (npmPackage && npmPackage.version !== version) fail(`server.json's npm package is ${npmPackage.version}, package.json is ${version}`);
if (!readFileSync("README.md", "utf8").includes(`github:phuryn/askone#v${version}`)) {
  fail(`README.md should pin installs to #v${version}`);
}

if (process.argv.includes("--verify-release")) {
  const response = await fetch(expectedUrl);
  if (!response.ok) fail(`${expectedUrl} answered HTTP ${response.status}`);
  const published = sha256(Buffer.from(await response.arrayBuffer()));
  if (published !== bundle.fileSha256) fail(`published asset is ${published}, server.json says ${bundle.fileSha256}`);
  console.log(`✓ v${version} release asset matches server.json (${published})`);
} else {
  execFileSync("npx", ["-y", MCPB_CLI, "pack", ".", "askone.mcpb"], { stdio: "inherit", shell: process.platform === "win32" });
  bundle.fileSha256 = sha256(readFileSync("askone.mcpb"));
  writeFileSync("server.json", `${JSON.stringify(server, null, 2)}\n`);
  console.log(`✓ askone.mcpb v${version}, SHA-256 ${bundle.fileSha256} written to server.json`);
}
