export type AgentAttention = {
    needsPermission: boolean;
    summary?: string;
};
export declare function permissionAttentionFromOutput(output: string): AgentAttention;
