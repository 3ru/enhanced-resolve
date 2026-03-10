"use strict";

const fs = require("fs");

const COMMENT_MARKER = "<!-- enhanced-resolve-unsafe-cache-benchmark -->";

/**
 * @typedef {object} FsOps
 * @property {number} lstatSync `lstatSync` call count.
 * @property {number} readFileSync `readFileSync` call count.
 * @property {number} readdirSync `readdirSync` call count.
 * @property {number} readlinkSync `readlinkSync` call count.
 * @property {number} realpathSync `realpathSync` call count.
 * @property {number} statSync `statSync` call count.
 */

/**
 * @typedef {object} BenchmarkTime
 * @property {number} max Maximum sample time in milliseconds.
 * @property {number} mean Mean sample time in milliseconds.
 * @property {number} median Median sample time in milliseconds.
 * @property {number} min Minimum sample time in milliseconds.
 * @property {number[]} samples Per-sample wall-clock times in milliseconds.
 */

/**
 * @typedef {object} BenchmarkVariant
 * @property {string} variant Variant name.
 * @property {number} cacheHitRate Cache hit rate for the variant.
 * @property {number} cacheHits Cache hits for the variant.
 * @property {number} cacheLookups Cache lookups for the variant.
 * @property {number} cacheMisses Cache misses for the variant.
 * @property {number} cacheUniqueKeys Unique cache keys written.
 * @property {number} cacheWrites Cache write count.
 * @property {FsOps} fsOps Filesystem operation counts.
 * @property {number} resolveCalls Total resolve calls executed.
 * @property {BenchmarkTime} timeMs Timing summary.
 */

/**
 * @typedef {object} BenchmarkOptions
 * @property {number} importers Root-package importer count.
 * @property {boolean} keepTempDir Whether to keep the temp workspace.
 * @property {number} nestedImporters Nested-package importer count.
 * @property {number} nestedPackages Nested-package count.
 * @property {number} samples Timed sample count.
 * @property {string[]} variants Benchmark variants to run.
 * @property {number} warmupSamples Warmup sample count.
 */

/**
 * @typedef {object} BenchmarkWorkload
 * @property {number} normalizedTopLevelKeyCount Modeled normalized key count.
 * @property {number} normalizedTopLevelReductionPct Theoretical key reduction.
 * @property {number} rawTopLevelKeyCount Raw key count without normalization.
 * @property {number} requestCount Total requests in the workload.
 */

/**
 * @typedef {object} BenchmarkResult
 * @property {string} benchmark Benchmark identifier.
 * @property {string} node Node.js version string.
 * @property {BenchmarkOptions} options Benchmark options.
 * @property {BenchmarkVariant[]} variants Per-variant results.
 * @property {BenchmarkWorkload} workload Workload summary.
 */

/**
 * @typedef {object} ParsedArgs
 * @property {string | null} baseFile Base result file path.
 * @property {string} baseLabel Base result label.
 * @property {string} currentFile Current result file path.
 * @property {string} currentLabel Current result label.
 * @property {"compare" | "single"} mode Render mode.
 */

/**
 * @param {string[]} argv raw argv
 * @param {number} index value index
 * @param {string} flag current flag
 * @returns {string} argument value
 */
function readValue(argv, index, flag) {
	const value = argv[index];
	if (typeof value !== "string") {
		throw new Error(`Missing value for ${flag}`);
	}
	return value;
}

/**
 * @param {string[]} argv raw argv
 * @returns {ParsedArgs} parsed args
 */
function parseArgs(argv) {
	/** @type {ParsedArgs} */
	const args = {
		baseFile: null,
		baseLabel: "base",
		currentFile: "",
		currentLabel: "current",
		mode: "single",
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--base":
				args.baseFile = readValue(argv, ++i, arg);
				args.mode = "compare";
				break;
			case "--base-label":
				args.baseLabel = readValue(argv, ++i, arg);
				break;
			case "--current":
				args.currentFile = readValue(argv, ++i, arg);
				break;
			case "--current-label":
				args.currentLabel = readValue(argv, ++i, arg);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!args.currentFile) {
		throw new Error("Missing required argument: --current");
	}

	return args;
}

/**
 * @param {string} filePath json path
 * @returns {BenchmarkResult} parsed result
 */
function readResult(filePath) {
	return /** @type {BenchmarkResult} */ (
		JSON.parse(fs.readFileSync(filePath, "utf8"))
	);
}

/**
 * @param {FsOps} fsOps fs ops
 * @returns {number} total fs operations
 */
function sumFsOps(fsOps) {
	return (
		fsOps.lstatSync +
		fsOps.readFileSync +
		fsOps.readdirSync +
		fsOps.readlinkSync +
		fsOps.realpathSync +
		fsOps.statSync
	);
}

/**
 * @param {number} value numeric value
 * @returns {string} formatted value
 */
function formatMs(value) {
	return `${value.toFixed(1)} ms`;
}

/**
 * @param {number} value numeric value
 * @returns {string} formatted percentage
 */
function formatPercent(value) {
	return `${(value * 100).toFixed(1)}%`;
}

/**
 * @param {BenchmarkResult} result benchmark result
 * @returns {Map<string, BenchmarkVariant>} variant map
 */
function mapVariants(result) {
	return new Map(result.variants.map((variant) => [variant.variant, variant]));
}

/**
 * @param {BenchmarkResult} result benchmark result
 * @returns {string} rendered command
 */
function renderCommand(result) {
	const { importers, nestedImporters, nestedPackages, samples, warmupSamples } =
		result.options;
	return (
		"`npm run benchmark:unsafe-cache-normalization -- " +
		`--samples ${samples} ` +
		`--warmup-samples ${warmupSamples} ` +
		`--importers ${importers} ` +
		`--nested-packages ${nestedPackages} ` +
		`--nested-importers ${nestedImporters}` +
		"`"
	);
}

/**
 * @param {number} before previous value
 * @param {number} after current value
 * @param {"higher" | "lower"} direction better direction
 * @param {(value: number) => string} formatter formatter
 * @returns {string} delta summary
 */
function formatDelta(before, after, direction, formatter) {
	if (before === after) {
		return `0 (${formatter(after)})`;
	}
	if (before === 0) {
		return after === 0 ? "0" : `n/a (${formatter(after)})`;
	}

	const delta = after - before;
	const ratio = delta / before;
	const improved =
		(direction === "higher" && delta > 0) ||
		(direction === "lower" && delta < 0);
	const sign = delta > 0 ? "+" : "";
	const directionLabel = improved ? "improved" : "regressed";
	return `${sign}${(ratio * 100).toFixed(1)}% (${directionLabel})`;
}

/**
 * @param {BenchmarkResult} result benchmark result
 * @returns {string[]} workload lines
 */
function renderWorkload(result) {
	return [
		`- requests: ${result.workload.requestCount}`,
		`- raw top-level keys: ${result.workload.rawTopLevelKeyCount}`,
		`- normalized top-level keys: ${result.workload.normalizedTopLevelKeyCount}`,
		`- theoretical key reduction: ${formatPercent(
			result.workload.normalizedTopLevelReductionPct,
		)}`,
		`- benchmark node: ${result.node}`,
	];
}

/**
 * @param {BenchmarkResult} result benchmark result
 * @param {string} label label for current result
 * @returns {string} markdown summary
 */
function renderSingle(result, label) {
	const lines = [
		COMMENT_MARKER,
		`## Unsafe Cache Benchmark (${label})`,
		"",
		"Workload:",
		...renderWorkload(result),
		"",
		"| Variant | Median time | Cache hit rate | Unique cache keys | Total fs ops |",
		"| --- | ---: | ---: | ---: | ---: |",
	];

	for (const variant of result.variants) {
		lines.push(
			`| ${variant.variant} | ${formatMs(
				variant.timeMs.median,
			)} | ${formatPercent(variant.cacheHitRate)} | ${
				variant.cacheUniqueKeys
			} | ${sumFsOps(variant.fsOps)} |`,
		);
	}

	lines.push("", "Command:", `- ${renderCommand(result)}`);
	return `${lines.join("\n")}\n`;
}

/**
 * @param {BenchmarkResult} baseResult base result
 * @param {BenchmarkResult} currentResult current result
 * @param {string} baseLabel base label
 * @param {string} currentLabel current label
 * @returns {string} markdown summary
 */
function renderCompare(baseResult, currentResult, baseLabel, currentLabel) {
	const lines = [
		COMMENT_MARKER,
		"## Unsafe Cache Benchmark",
		"",
		"Workload:",
		...renderWorkload(currentResult),
		"",
		`Compared \`${baseLabel}\` -> \`${currentLabel}\``,
		"",
		"| Variant | Median time | Delta | Cache hit rate | Delta | Unique cache keys | Delta | Total fs ops | Delta |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];

	const baseVariants = mapVariants(baseResult);
	const currentVariants = mapVariants(currentResult);

	for (const variantName of currentResult.options.variants) {
		const currentVariant = currentVariants.get(variantName);
		const baseVariant = baseVariants.get(variantName);
		if (!currentVariant || !baseVariant) {
			continue;
		}

		lines.push(
			`| ${variantName} | ${formatMs(currentVariant.timeMs.median)} | ${formatDelta(
				baseVariant.timeMs.median,
				currentVariant.timeMs.median,
				"lower",
				formatMs,
			)} | ${formatPercent(currentVariant.cacheHitRate)} | ${formatDelta(
				baseVariant.cacheHitRate,
				currentVariant.cacheHitRate,
				"higher",
				formatPercent,
			)} | ${currentVariant.cacheUniqueKeys} | ${formatDelta(
				baseVariant.cacheUniqueKeys,
				currentVariant.cacheUniqueKeys,
				"lower",
				String,
			)} | ${sumFsOps(currentVariant.fsOps)} | ${formatDelta(
				sumFsOps(baseVariant.fsOps),
				sumFsOps(currentVariant.fsOps),
				"lower",
				String,
			)} |`,
		);
	}

	lines.push("", "Command:", `- ${renderCommand(currentResult)}`);

	return `${lines.join("\n")}\n`;
}

/**
 * Runs the result formatter in single-result or compare mode.
 * @returns {void}
 */
function main() {
	const args = parseArgs(process.argv.slice(2));
	const currentResult = readResult(args.currentFile);

	if (args.mode === "compare") {
		if (!args.baseFile) {
			throw new Error("Missing base file for compare mode");
		}

		const baseResult = readResult(args.baseFile);
		process.stdout.write(
			renderCompare(
				baseResult,
				currentResult,
				args.baseLabel,
				args.currentLabel,
			),
		);
		return;
	}

	process.stdout.write(renderSingle(currentResult, args.currentLabel));
}

main();
