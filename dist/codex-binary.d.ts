export declare const RUDDER_CODEX_REPOSITORY = "viraatdas/codex";
export declare const RUDDER_CODEX_RELEASE = "rudder-codex-v0.1.1-upstream-db9cb04";
export declare const RUDDER_CODEX_ASSET_SHA256 = "ea08a91e85b35c0c4782a96535011dfcaeaff7259113e65ecf5260bc24368517";
export declare function codexEnvVars(): Promise<Record<string, string>>;
export declare function codexLaunchEnv(base?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>;
export declare function ensureRudderCodexBinary(): Promise<string>;
export declare function managedBinaryPath(): string;
