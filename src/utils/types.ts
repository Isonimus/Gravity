/**
 * Gravity - Type Definitions
 */

// ============================================================================
// Quota Data Types
// ============================================================================

export interface ModelQuotaInfo {
    label: string;
    modelId: string;
    remainingFraction?: number;
    remainingPercentage?: number;
    isExhausted: boolean;
    resetTime: Date;
    timeUntilReset: number;
    timeUntilResetFormatted: string;
}

export interface PromptCreditsInfo {
    available: number;
    monthly: number;
    usedPercentage: number;
    remainingPercentage: number;
}

export interface QuotaSnapshot {
    timestamp: Date;
    promptCredits?: PromptCreditsInfo;
    models: ModelQuotaInfo[];
}

// ============================================================================
// Guard Types
// ============================================================================

export type GuardLevel = 'normal' | 'warning' | 'critical' | 'blocked';

export interface GuardState {
    level: GuardLevel;
    modelsAtRisk: ModelQuotaInfo[];
    lowestQuota: number;
    lowestQuotaModel?: ModelQuotaInfo;
    guardActive: boolean;
}

export interface GuardCheckResult {
    shouldWarn: boolean;
    shouldBlock: boolean;
    level: GuardLevel;
    model: ModelQuotaInfo;
    message: string;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface GravityConfig {
    enabled: boolean;
    warningThreshold: number;
    blockThreshold: number;
    pollingInterval: number;
    guardEnabled: boolean;
    pinnedModels: string[];
}

// ============================================================================
// Server Response Types (match Antigravity API)
// ============================================================================

export interface ServerUserStatusResponse {
    userStatus: {
        name: string;
        email: string;
        planStatus?: {
            planInfo: {
                teamsTier: string;
                planName: string;
                monthlyPromptCredits: number;
                monthlyFlowCredits: number;
            };
            availablePromptCredits: number;
            availableFlowCredits: number;
        };
        cascadeModelConfigData?: {
            clientModelConfigs: ServerModelConfig[];
        };
    };
}

export interface ServerModelConfig {
    label: string;
    modelOrAlias?: {
        model: string;
    };
    quotaInfo?: {
        remainingFraction?: number;
        resetTime: string;
    };
    supportsImages?: boolean;
    isRecommended?: boolean;
    allowedTiers?: string[];
}

// ============================================================================
// Process Detection Types
// ============================================================================

export interface ProcessInfo {
    extensionPort: number;
    connectPort: number;
    csrfToken: string;
}

export interface ParsedProcessInfo {
    pid: number;
    extensionPort: number;
    csrfToken: string;
}
