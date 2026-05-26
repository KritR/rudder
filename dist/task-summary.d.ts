export declare function summarizeTask(task: string, maxChars?: number): string;
export declare function taskDisplayLabel(run: {
    task: string;
    taskSummary?: string;
}, maxChars?: number): string;
export declare function llmSummarizeTask(task: string): Promise<string | null>;
