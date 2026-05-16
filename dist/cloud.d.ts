type CloudCommandOptions = {
    json?: boolean;
    homePaths?: string[];
    sshHost?: string;
    noAttach?: boolean;
    quietBanner?: boolean;
};
export declare function runCloudCommand(command: string, args: string[], options?: CloudCommandOptions): Promise<void>;
export {};
