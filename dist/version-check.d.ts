/**
 * Returns the latest published version if our local version is older, otherwise null.
 * Cached for 6h on disk so startup doesn't hit the network every launch. Never throws.
 * Disabled when RUDDER_DISABLE_UPDATE_CHECK is set.
 */
export declare function getUpdateAvailable(): Promise<{
    current: string;
    latest: string;
} | null>;
