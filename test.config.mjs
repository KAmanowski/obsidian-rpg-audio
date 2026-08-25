import esbuild from "esbuild";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const testRoot = new URL("tests/", import.meta.url);
const entryPoints = (await readdir(testRoot))
	.filter(name => name.endsWith(".test.ts"))
	.map(name => fileURLToPath(new URL(name, testRoot)));
const outputDir = await mkdtemp(join(tmpdir(), "rpg-audio-tests-"));

try {
	await esbuild.build({
		entryPoints,
		bundle: true,
		platform: "node",
		format: "cjs",
		outdir: outputDir,
		logLevel: "warning",
	});

	const testFiles = (await readdir(outputDir))
		.filter(name => name.endsWith(".test.js"))
		.map(name => join(outputDir, name));
	const result = spawnSync(process.execPath, ["--test", ...testFiles], {stdio: "inherit"});
	process.exitCode = result.status ?? 1;
} finally {
	await rm(outputDir, {recursive: true, force: true});
}
