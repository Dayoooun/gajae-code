export interface EmbeddedAddonFile {
	variant: "modern" | "baseline" | "default";
	filename: string;
	filePath: string;
}

export interface EmbeddedAddon {
	platformTag: string;
	version: string;
	files: EmbeddedAddonFile[];
}

export interface DetectCompiledBinaryInput {
	embeddedAddon: EmbeddedAddon | null | undefined;
	env: Record<string, string | undefined>;
	importMetaUrl: string | null | undefined;
}

export function detectCompiledBinary(input: DetectCompiledBinaryInput): boolean;

export interface GetAddonFilenamesInput {
	tag: string;
	arch: string;
	variant: "modern" | "baseline" | null | undefined;
}

export function getAddonFilenames(input: GetAddonFilenamesInput): string[];

export function getOptionalPackageNames(platformTag: string): string[];

export interface ResolveOptionalPackageNativeDirsInput {
	packageNames: string[];
	requireResolve: (id: string) => string;
}

export function resolveOptionalPackageNativeDirs(input: ResolveOptionalPackageNativeDirsInput): string[];

export interface ShouldStageNodeModulesAddonInput {
	platform: NodeJS.Platform | string;
	isCompiledBinary: boolean;
	nativeDir: string;
}

export function shouldStageNodeModulesAddon(input: ShouldStageNodeModulesAddonInput): boolean;

export interface ResolveLoaderCandidatesInput {
	addonFilenames: string[];
	isCompiledBinary: boolean;
	stageFromNodeModules?: boolean;
	isWorkspaceLoad?: boolean;
	optionalPackageNativeDirs?: string[];
	nativeDir: string;
	execDir: string;
	versionedDir: string;
	userDataDir: string;
}

export function resolveLoaderCandidates(input: ResolveLoaderCandidatesInput): string[];

export interface LoadFromCandidatesInput<T> {
	candidates: string[];
	/** Runs immediately before loading a candidate and must throw when it is no longer eligible. */
	attestCandidate?: (candidate: string) => void;
	/** Binds a validated candidate to the stable path passed to the module loader. */
	bindCandidate?: (candidate: string) => string;
	/** Runs after every bound load attempt, including validation and require failures. */
	cleanupCandidate?: (candidate: string) => void;
	requireCandidate: (candidate: string) => T;
	validateCandidate: (bindings: T, candidate: string) => void;
	describeCandidate: (candidate: string) => string;
}

export interface LoadFromCandidatesResult<T> {
	bindings: T | null;
	errors: string[];
}

export function loadFromCandidates<T>(input: LoadFromCandidatesInput<T>): LoadFromCandidatesResult<T>;

export interface CachedEmbeddedExtractionIsFreshInput {
	targetPath: string;
	embeddedPath: string;
	contentHash: (path: string) => string | null;
}

export function cachedEmbeddedExtractionIsFresh(input: CachedEmbeddedExtractionIsFreshInput): boolean;

export interface GetImmutableEmbeddedCachePathInput {
	cacheDir: string;
	filename: string;
	contentHash: string;
}

/** Returns null unless filename and contentHash can form a safe immutable cache identity. */
export function getImmutableEmbeddedCachePath(input: GetImmutableEmbeddedCachePathInput): string | null;

export interface ResolveRuntimeCandidatesInput {
	candidates: string[];
	embeddedCandidate?: string | null;
	stagedCandidate?: string | null;
	/** When present, excludes every candidate not content-attested by the embedded or locally built addon. */
	validatedCandidates?: string[];
}

export function resolveRuntimeCandidates(input: ResolveRuntimeCandidatesInput): string[];

export interface PrivateLoadDirectoryInput {
	loadDir: string;
	platform?: NodeJS.Platform | string;
}

export function cleanupPrivateLoadDirectory(input: PrivateLoadDirectoryInput): void;
export function prunePrivateLoadDirectories(input: { cacheDir: string }): number;

export function loadNative(): Record<string, unknown>;
