export interface ModelInfo {
    id: string;
    name: string;
    temperatureSupport: 'supported' | 'unsupported' | 'unknown';
    temperatureMax?: number;
    outputTokenLimit?: number;
    reasoning?: boolean;
    thinkingSupport?: boolean;
    generationSupport?: 'supported' | 'unknown';
}
