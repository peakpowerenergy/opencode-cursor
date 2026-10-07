export interface CursorModel {
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
}
export declare function getCursorModels(apiKey: string): Promise<CursorModel[]>;
export declare function cursorModelsFromCloudItems(items: readonly {
    id?: string;
    displayName?: string;
}[]): CursorModel[];
/** @internal Test-only. */
export declare function clearModelCache(): void;
