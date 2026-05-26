export declare const RUDDER_CODEX_REPOSITORY = "viraatdas/codex";
export declare const RUDDER_CODEX_RELEASE = "rudder-codex-v0.1.0-upstream-db9cb04";
export declare const RUDDER_CODEX_ASSET_SHA256 = "9f9577d244e83e5711b64b781527e32538b78d4005141dc33c6bed8f3296ded7";
export declare function codexEnvVars(): Promise<Record<string, string>>;
export declare function codexLaunchEnv(base?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>;
export declare function ensureRudderCodexBinary(): Promise<string>;
export declare function managedBinaryPath(): string;
