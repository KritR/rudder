type CloudCommandOptions = {
    json?: boolean;
    homePaths?: string[];
};
export declare function runCloudCommand(command: string, args: string[], options?: CloudCommandOptions): Promise<void>;
export {};
