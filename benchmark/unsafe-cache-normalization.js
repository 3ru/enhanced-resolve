"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const enhancedResolve = require("..");

const { CachedInputFileSystem, ResolverFactory } = enhancedResolve;

const DEFAULT_OPTIONS = {
	importers: 800,
	nestedPackages: 4,
	nestedImporters: 120,
	samples: 5,
	warmupSamples: 1,
	keepTempDir: false,
	variants: ["raw-fs", "cached-input-fs"],
};

/**
 * @typedef {{
 * absoluteTarget: string,
 * importerDirs: string[],
 * importsTarget: string,
 * packageRoot: string,
 * reactTarget: string,
 * relativeTarget: string,
 * scopedTarget: string
 * }} PackageLayout
 */

/**
 * @typedef {{
 * context: string,
 * expected: string,
 * packageRoot: string,
 * request: string
 * }} WorkloadItem
 */

/**
 * @param {string[]} argv raw argv
 * @param {number} index value index
 * @param {string} flag flag
 * @returns {number} parsed integer
 */
function readNonNegativeInt(argv, index, flag) {
	const value = argv[index];
	if (typeof value !== "string") {
		throw new Error(`Missing value for ${flag}`);
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${flag} must be a non-negative integer`);
	}
	return parsed;
}

/**
 * @param {string[]} argv raw argv
 * @param {number} index value index
 * @param {string} flag flag
 * @returns {number} parsed integer
 */
function readPositiveInt(argv, index, flag) {
	const value = readNonNegativeInt(argv, index, flag);
	if (value <= 0) {
		throw new Error(`${flag} must be greater than 0`);
	}
	return value;
}

/**
 * @param {string[]} argv raw argv
 * @param {number} index value index
 * @param {string} flag flag
 * @returns {string[]} variants
 */
function readVariants(argv, index, flag) {
	const value = argv[index];
	if (typeof value !== "string") {
		throw new Error(`Missing value for ${flag}`);
	}
	const variants = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	if (variants.length === 0) {
		throw new Error(`${flag} must contain at least one variant`);
	}
	for (const variant of variants) {
		if (variant !== "raw-fs" && variant !== "cached-input-fs") {
			throw new Error(`Unsupported variant: ${variant}`);
		}
	}
	return variants;
}

/**
 * @param {string[]} argv raw argv
 * @returns {typeof DEFAULT_OPTIONS} parsed options
 */
function parseArgs(argv) {
	/** @type {typeof DEFAULT_OPTIONS} */
	const options = {
		...DEFAULT_OPTIONS,
		variants: [...DEFAULT_OPTIONS.variants],
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--importers":
				options.importers = readPositiveInt(argv, ++i, arg);
				break;
			case "--nested-packages":
				options.nestedPackages = readPositiveInt(argv, ++i, arg);
				break;
			case "--nested-importers":
				options.nestedImporters = readPositiveInt(argv, ++i, arg);
				break;
			case "--samples":
				options.samples = readPositiveInt(argv, ++i, arg);
				break;
			case "--warmup-samples":
				options.warmupSamples = readNonNegativeInt(argv, ++i, arg);
				break;
			case "--variants":
				options.variants = readVariants(argv, ++i, arg);
				break;
			case "--keep-temp-dir":
				options.keepTempDir = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

/**
 * @param {number} value numeric value
 * @returns {string} padded string
 */
function pad(value) {
	return String(value).padStart(4, "0");
}

/**
 * @param {string} filePath file path
 * @param {string} content file content
 * @returns {void}
 */
function writeFile(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

/**
 * @param {string} filePath file path
 * @param {object} value json value
 * @returns {void}
 */
function writeJson(filePath, value) {
	writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} relativePath relative path
 * @returns {string} normalized request with a leading dot
 */
function normalizeRelativeRequest(relativePath) {
	const normalized = path.posix.normalize(relativePath);
	return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

/**
 * @param {string} from from path
 * @param {string} to to path
 * @returns {string} relative request string
 */
function createRelativeRequest(from, to) {
	return normalizeRelativeRequest(
		path.relative(from, to).split(path.sep).join("/"),
	);
}

/**
 * @param {string} packageRoot package root
 * @param {string} importerDir importer directory
 * @param {string} request request
 * @returns {string} normalized request for issue #449's proposed cache key
 */
function normalizeRequestWithinPackage(packageRoot, importerDir, request) {
	if (!/^\.\.?(?:\/|$)/.test(request)) {
		return request;
	}
	const relativePath = createRelativeRequest(packageRoot, importerDir);
	return normalizeRelativeRequest(path.posix.join(relativePath, request));
}

/**
 * @param {string} packageRoot package root
 * @param {string} importsValue import mapping
 * @returns {PackageLayout} package layout
 */
function createPackageLayout(packageRoot, importsValue) {
	const reactTarget = path.join(
		packageRoot,
		"node_modules",
		"react",
		"index.js",
	);
	const scopedTarget = path.join(
		packageRoot,
		"node_modules",
		"@scope",
		"pkg",
		"index.js",
	);
	const importsTarget = path.join(packageRoot, importsValue);
	const relativeTarget = path.join(packageRoot, "src", "shared", "index.js");
	const absoluteTarget = path.join(packageRoot, "src", "absolute", "entry.js");

	/** @type {PackageLayout} */
	return {
		absoluteTarget,
		importerDirs: [],
		importsTarget,
		packageRoot,
		reactTarget,
		relativeTarget,
		scopedTarget,
	};
}

/**
 * @param {string} packageRoot package root
 * @param {string} packageName package name
 * @param {number} importerCount importer count
 * @returns {PackageLayout} package layout
 */
function createPackage(packageRoot, packageName, importerCount) {
	writeJson(path.join(packageRoot, "package.json"), {
		name: packageName,
		imports: {
			"#shared": "./src/imports/shared.js",
		},
	});
	writeFile(
		path.join(packageRoot, "src", "shared", "index.js"),
		`module.exports = ${JSON.stringify(`${packageName}:shared`)};\n`,
	);
	writeFile(
		path.join(packageRoot, "src", "imports", "shared.js"),
		`module.exports = ${JSON.stringify(`${packageName}:imports`)};\n`,
	);
	writeFile(
		path.join(packageRoot, "src", "absolute", "entry.js"),
		`module.exports = ${JSON.stringify(`${packageName}:absolute`)};\n`,
	);
	writeJson(path.join(packageRoot, "node_modules", "react", "package.json"), {
		name: "react",
		main: "index.js",
	});
	writeFile(
		path.join(packageRoot, "node_modules", "react", "index.js"),
		`module.exports = ${JSON.stringify(`${packageName}:react`)};\n`,
	);
	writeJson(
		path.join(packageRoot, "node_modules", "@scope", "pkg", "package.json"),
		{
			name: "@scope/pkg",
			main: "index.js",
		},
	);
	writeFile(
		path.join(packageRoot, "node_modules", "@scope", "pkg", "index.js"),
		`module.exports = ${JSON.stringify(`${packageName}:scoped`)};\n`,
	);

	const layout = createPackageLayout(
		packageRoot,
		path.join("src", "imports", "shared.js"),
	);
	for (let i = 0; i < importerCount; i++) {
		const importerDir = path.join(
			packageRoot,
			"src",
			"generated",
			`group-${pad(Math.floor(i / 40))}`,
			`bucket-${pad(Math.floor(i / 10))}`,
			`leaf-${pad(i)}`,
		);
		fs.mkdirSync(importerDir, { recursive: true });
		layout.importerDirs.push(importerDir);
	}

	return layout;
}

/**
 * @param {string} workspaceRoot workspace root
 * @param {typeof DEFAULT_OPTIONS} options benchmark options
 * @returns {{ nestedLayouts: PackageLayout[], rootLayout: PackageLayout, tempRoot: string, workload: WorkloadItem[] }} generated workspace
 */
function createWorkspace(workspaceRoot, options) {
	const createdTempRoot = fs.mkdtempSync(
		path.join(workspaceRoot, "unsafe-cache-normalization-"),
	);
	const tempRoot =
		typeof fs.realpathSync.native === "function"
			? fs.realpathSync.native(createdTempRoot)
			: fs.realpathSync(createdTempRoot);
	const rootPackageDir = path.join(tempRoot, "root-package");
	const rootLayout = createPackage(
		rootPackageDir,
		"root-package",
		options.importers,
	);

	/** @type {PackageLayout[]} */
	const nestedLayouts = [];
	for (let i = 0; i < options.nestedPackages; i++) {
		const nestedRoot = path.join(
			rootPackageDir,
			"packages",
			`nested-${pad(i)}`,
		);
		nestedLayouts.push(
			createPackage(
				nestedRoot,
				`nested-package-${pad(i)}`,
				options.nestedImporters,
			),
		);
	}

	/** @type {WorkloadItem[]} */
	const workload = [];
	for (const layout of [rootLayout, ...nestedLayouts]) {
		for (const importerDir of layout.importerDirs) {
			workload.push({
				context: importerDir,
				expected: layout.reactTarget,
				packageRoot: layout.packageRoot,
				request: "react",
			});
			workload.push({
				context: importerDir,
				expected: layout.scopedTarget,
				packageRoot: layout.packageRoot,
				request: "@scope/pkg",
			});
			workload.push({
				context: importerDir,
				expected: layout.importsTarget,
				packageRoot: layout.packageRoot,
				request: "#shared",
			});
			workload.push({
				context: importerDir,
				expected: layout.absoluteTarget,
				packageRoot: layout.packageRoot,
				request: layout.absoluteTarget,
			});
			workload.push({
				context: importerDir,
				expected: layout.relativeTarget,
				packageRoot: layout.packageRoot,
				request: createRelativeRequest(importerDir, layout.relativeTarget),
			});
		}
	}

	return { nestedLayouts, rootLayout, tempRoot, workload };
}

/**
 * @param {WorkloadItem[]} workload workload
 * @returns {{ normalizedTopLevelKeyCount: number, normalizedTopLevelReductionPct: number, rawTopLevelKeyCount: number, requestCount: number }} workload summary
 */
function analyzeWorkload(workload) {
	const rawKeys = new Set();
	const normalizedKeys = new Set();

	for (const item of workload) {
		rawKeys.add(JSON.stringify({ path: item.context, request: item.request }));
		normalizedKeys.add(
			JSON.stringify({
				path: item.packageRoot,
				request: normalizeRequestWithinPackage(
					item.packageRoot,
					item.context,
					item.request,
				),
			}),
		);
	}

	const rawTopLevelKeyCount = rawKeys.size;
	const normalizedTopLevelKeyCount = normalizedKeys.size;
	return {
		normalizedTopLevelKeyCount,
		normalizedTopLevelReductionPct:
			rawTopLevelKeyCount === 0
				? 0
				: (rawTopLevelKeyCount - normalizedTopLevelKeyCount) /
					rawTopLevelKeyCount,
		rawTopLevelKeyCount,
		requestCount: workload.length,
	};
}

/**
 * Create an unsafe cache object that records lookups and writes.
 * @returns {{ cache: { [k: string]: unknown }, stats: { hits: number, lookups: number, misses: number, uniqueKeys: number, writes: number } }} measured cache
 */
function createMeasuredCache() {
	const backingStore = Object.create(null);
	const stats = {
		hits: 0,
		lookups: 0,
		misses: 0,
		uniqueKeys: 0,
		writes: 0,
	};

	const cache = new Proxy(backingStore, {
		get(target, property) {
			if (typeof property !== "string") {
				return target[property];
			}
			stats.lookups++;
			if (
				Object.prototype.hasOwnProperty.call(target, property) &&
				target[property]
			) {
				stats.hits++;
			} else {
				stats.misses++;
			}
			return target[property];
		},
		set(target, property, value) {
			if (typeof property === "string") {
				if (!Object.prototype.hasOwnProperty.call(target, property)) {
					stats.uniqueKeys++;
				}
				stats.writes++;
			}
			target[property] = value;
			return true;
		},
	});

	return { cache, stats };
}

/**
 * Create a sync filesystem wrapper that counts underlying operations.
 * @returns {{ fileSystem: import("../lib/CachedInputFileSystem").BaseFileSystem, stats: { lstatSync: number, readFileSync: number, readdirSync: number, readlinkSync: number, realpathSync: number, statSync: number } }} instrumented filesystem
 */
function createInstrumentedSyncFileSystem() {
	const stats = {
		lstatSync: 0,
		readFileSync: 0,
		readdirSync: 0,
		readlinkSync: 0,
		realpathSync: 0,
		statSync: 0,
	};

	const fileSystem = {
		lstatSync(filePath, options) {
			stats.lstatSync++;
			return fs.lstatSync(filePath, options);
		},
		readFileSync(filePath, options) {
			stats.readFileSync++;
			return fs.readFileSync(filePath, options);
		},
		readdirSync(filePath, options) {
			stats.readdirSync++;
			return fs.readdirSync(filePath, options);
		},
		readlinkSync(filePath, options) {
			stats.readlinkSync++;
			return fs.readlinkSync(filePath, options);
		},
		realpathSync(filePath, options) {
			stats.realpathSync++;
			return fs.realpathSync(filePath, options);
		},
		statSync(filePath, options) {
			stats.statSync++;
			return fs.statSync(filePath, options);
		},
	};

	return { fileSystem, stats };
}

/**
 * @param {"raw-fs" | "cached-input-fs"} variant benchmark variant
 * @returns {{ fileSystem: import("../lib/CachedInputFileSystem").BaseFileSystem, fsStats: ReturnType<typeof createInstrumentedSyncFileSystem>["stats"] }} benchmark filesystem
 */
function createBenchmarkFileSystem(variant) {
	const { fileSystem, stats } = createInstrumentedSyncFileSystem();
	if (variant === "cached-input-fs") {
		return {
			fileSystem: new CachedInputFileSystem(fileSystem, 60000),
			fsStats: stats,
		};
	}
	return { fileSystem, fsStats: stats };
}

/**
 * @param {import("../lib/CachedInputFileSystem").BaseFileSystem} fileSystem benchmark fs
 * @param {object} cache unsafe cache implementation
 * @returns {import("../lib/Resolver").Resolver} resolver instance
 */
function createResolver(fileSystem, cache) {
	return ResolverFactory.createResolver({
		conditionNames: ["node"],
		descriptionFiles: ["package.json"],
		extensions: [".js", ".json", ".node"],
		fileSystem,
		importsFields: ["imports"],
		mainFields: ["main"],
		mainFiles: ["index"],
		modules: ["node_modules"],
		unsafeCache: cache,
		useSyncFileSystemCalls: true,
	});
}

/**
 * @param {WorkloadItem[]} workload workload
 * @param {"raw-fs" | "cached-input-fs"} variant benchmark variant
 * @returns {{
 * cacheHitRate: number,
 * cacheHits: number,
 * cacheLookups: number,
 * cacheMisses: number,
 * cacheUniqueKeys: number,
 * cacheWrites: number,
 * fsOps: ReturnType<typeof createInstrumentedSyncFileSystem>["stats"],
 * resolveCalls: number,
 * timeMs: number
 * }} measurement result
 */
function runSample(workload, variant) {
	const { cache, stats: cacheStats } = createMeasuredCache();
	const { fileSystem, fsStats } = createBenchmarkFileSystem(variant);
	const resolver = createResolver(fileSystem, cache);

	const start = process.hrtime.bigint();
	for (const item of workload) {
		const result = resolver.resolveSync({}, item.context, item.request);
		if (result !== item.expected) {
			throw new Error(
				[
					"Unexpected benchmark result",
					`  variant: ${variant}`,
					`  context: ${item.context}`,
					`  request: ${item.request}`,
					`  expected: ${item.expected}`,
					`  received: ${result}`,
				].join("\n"),
			);
		}
	}
	const end = process.hrtime.bigint();

	return {
		cacheHitRate:
			cacheStats.lookups === 0 ? 0 : cacheStats.hits / cacheStats.lookups,
		cacheHits: cacheStats.hits,
		cacheLookups: cacheStats.lookups,
		cacheMisses: cacheStats.misses,
		cacheUniqueKeys: cacheStats.uniqueKeys,
		cacheWrites: cacheStats.writes,
		fsOps: { ...fsStats },
		resolveCalls: workload.length,
		timeMs: Number(end - start) / 1e6,
	};
}

/**
 * @param {number[]} values numeric values
 * @returns {{ max: number, mean: number, median: number, min: number, samples: number[] }} summary values
 */
function summarizeValues(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const sum = values.reduce((total, value) => total + value, 0);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0
			? (sorted[middle - 1] + sorted[middle]) / 2
			: sorted[middle];
	return {
		max: sorted[sorted.length - 1],
		mean: sum / values.length,
		median,
		min: sorted[0],
		samples: values,
	};
}

/**
 * @param {unknown[]} samples benchmark samples
 * @returns {unknown} stable metrics
 */
function ensureStableMetrics(samples) {
	const [first, ...rest] = samples.map((sample) => JSON.stringify(sample));
	for (const candidate of rest) {
		if (candidate !== first) {
			throw new Error(
				"Benchmark instrumentation produced unstable non-timing metrics across identical samples",
			);
		}
	}
	return JSON.parse(first);
}

/**
 * @param {WorkloadItem[]} workload workload
 * @param {"raw-fs" | "cached-input-fs"} variant benchmark variant
 * @param {typeof DEFAULT_OPTIONS} options options
 * @returns {{
 * cacheHitRate: number,
 * cacheHits: number,
 * cacheLookups: number,
 * cacheMisses: number,
 * cacheUniqueKeys: number,
 * cacheWrites: number,
 * fsOps: ReturnType<typeof createInstrumentedSyncFileSystem>["stats"],
 * resolveCalls: number,
 * timeMs: ReturnType<typeof summarizeValues>,
 * variant: string
 * }} variant summary
 */
function runVariant(workload, variant, options) {
	for (let i = 0; i < options.warmupSamples; i++) {
		if (typeof global.gc === "function") {
			global.gc();
		}
		runSample(workload, variant);
	}

	/** @type {ReturnType<typeof runSample>[]} */
	const samples = [];
	for (let i = 0; i < options.samples; i++) {
		if (typeof global.gc === "function") {
			global.gc();
		}
		samples.push(runSample(workload, variant));
	}

	const stableMetrics = ensureStableMetrics(
		samples.map((sample) => ({
			cacheHitRate: sample.cacheHitRate,
			cacheHits: sample.cacheHits,
			cacheLookups: sample.cacheLookups,
			cacheMisses: sample.cacheMisses,
			cacheUniqueKeys: sample.cacheUniqueKeys,
			cacheWrites: sample.cacheWrites,
			fsOps: sample.fsOps,
			resolveCalls: sample.resolveCalls,
		})),
	);

	return {
		...stableMetrics,
		timeMs: summarizeValues(samples.map((sample) => sample.timeMs)),
		variant,
	};
}

/**
 * Remove a directory tree without relying on newer Node.js helpers.
 * @param {string} targetPath file or directory to remove
 * @returns {void}
 */
function removeTree(targetPath) {
	if (!fs.existsSync(targetPath)) {
		return;
	}
	const stat = fs.lstatSync(targetPath);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		fs.unlinkSync(targetPath);
		return;
	}
	for (const entry of fs.readdirSync(targetPath)) {
		removeTree(path.join(targetPath, entry));
	}
	fs.rmdirSync(targetPath);
}

/**
 * Run the benchmark and print JSON results.
 * @returns {void}
 */
function main() {
	const options = parseArgs(process.argv.slice(2));
	const workspaceRoot = os.tmpdir();
	const workspace = createWorkspace(workspaceRoot, options);

	try {
		const analysis = analyzeWorkload(workspace.workload);
		const variants = options.variants.map((variant) =>
			runVariant(workspace.workload, variant, options),
		);

		const summary = {
			benchmark: "unsafe-cache-normalization",
			node: process.version,
			options: {
				importers: options.importers,
				keepTempDir: options.keepTempDir,
				nestedImporters: options.nestedImporters,
				nestedPackages: options.nestedPackages,
				samples: options.samples,
				variants: options.variants,
				warmupSamples: options.warmupSamples,
			},
			workspace: {
				nestedPackageCount: workspace.nestedLayouts.length,
				rootPackage: workspace.rootLayout.packageRoot,
				tempRoot: workspace.tempRoot,
			},
			workload: analysis,
			variants,
		};

		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	} finally {
		if (!options.keepTempDir) {
			removeTree(workspace.tempRoot);
		}
	}
}

main();
