/**
 * Gravity - Quota Guard Service
 * 
 * Core protection logic that monitors quota levels and triggers warnings/blocks.
 */

import * as vscode from 'vscode';
import {
    QuotaSnapshot,
    ModelQuotaInfo,
    GuardState,
    GuardLevel,
    GuardCheckResult,
    GravityConfig,
} from '../utils/types';
import { logger } from '../utils/logger';

const LOG_CAT = 'QuotaGuard';

export class QuotaGuard {
    private lastSnapshot?: QuotaSnapshot;
    private config: GravityConfig;
    private guardState: GuardState;
    private dismissedWarnings: Set<string> = new Set();
    private lastBlockShown: number = 0;
    private readonly blockCooldown = 30000; // 30 seconds between block modals

    constructor(config: GravityConfig) {
        this.config = config;
        this.guardState = {
            level: 'normal',
            modelsAtRisk: [],
            lowestQuota: 100,
            guardActive: config.guardEnabled,
        };
    }

    updateConfig(config: GravityConfig): void {
        this.config = config;
        this.guardState.guardActive = config.guardEnabled;
        logger.debug(LOG_CAT, 'Config updated', config);
    }

    updateSnapshot(snapshot: QuotaSnapshot): GuardState {
        this.lastSnapshot = snapshot;
        this.guardState = this.analyzeQuotaState(snapshot);

        logger.debug(LOG_CAT, 'Guard state updated:', {
            level: this.guardState.level,
            lowestQuota: this.guardState.lowestQuota.toFixed(1) + '%',
            modelsAtRisk: this.guardState.modelsAtRisk.map((m) => m.label),
        });

        return this.guardState;
    }

    getState(): GuardState {
        return this.guardState;
    }

    isGuardActive(): boolean {
        return this.guardState.guardActive;
    }

    toggleGuard(): boolean {
        this.guardState.guardActive = !this.guardState.guardActive;
        logger.info(LOG_CAT, `Guard ${this.guardState.guardActive ? 'enabled' : 'disabled'}`);
        return this.guardState.guardActive;
    }

    /**
     * Check if an action should be warned/blocked and show appropriate UI.
     * Call this before allowing AI actions.
     */
    async checkAndWarn(): Promise<boolean> {
        if (!this.guardState.guardActive) {
            return true; // Allow action
        }

        const modelsAtRisk = this.getModelsRequiringAttention();

        if (modelsAtRisk.length === 0) {
            return true; // All clear
        }

        // Get the worst model (lowest quota)
        const worstModel = modelsAtRisk.reduce((worst, current) => {
            const worstPct = worst.remainingPercentage ?? 100;
            const currentPct = current.remainingPercentage ?? 100;
            return currentPct < worstPct ? current : worst;
        });

        const check = this.checkModel(worstModel);

        if (check.shouldBlock) {
            return await this.showBlockModal(check);
        } else if (check.shouldWarn) {
            return await this.showWarningModal(check);
        }

        return true;
    }

    private analyzeQuotaState(snapshot: QuotaSnapshot): GuardState {
        const modelsAtRisk: ModelQuotaInfo[] = [];
        let lowestQuota = 100;
        let lowestQuotaModel: ModelQuotaInfo | undefined;

        for (const model of snapshot.models) {
            const pct = model.remainingPercentage ?? 100;

            if (pct < lowestQuota) {
                lowestQuota = pct;
                lowestQuotaModel = model;
            }

            if (pct <= this.config.warningThreshold) {
                modelsAtRisk.push(model);
            }
        }

        let level: GuardLevel = 'normal';
        if (lowestQuota <= 0) {
            level = 'blocked';
        } else if (lowestQuota <= this.config.blockThreshold) {
            level = 'critical';
        } else if (lowestQuota <= this.config.warningThreshold) {
            level = 'warning';
        }

        return {
            level,
            modelsAtRisk,
            lowestQuota,
            lowestQuotaModel,
            guardActive: this.config.guardEnabled,
        };
    }

    private getModelsRequiringAttention(): ModelQuotaInfo[] {
        if (!this.lastSnapshot) { return []; }

        return this.lastSnapshot.models.filter((model) => {
            const pct = model.remainingPercentage ?? 100;
            return pct <= this.config.warningThreshold;
        });
    }

    private checkModel(model: ModelQuotaInfo): GuardCheckResult {
        const pct = model.remainingPercentage ?? 100;
        const { blockThreshold, warningThreshold } = this.config;

        let level: GuardLevel = 'normal';
        let shouldWarn = false;
        let shouldBlock = false;
        let message = '';

        if (pct <= 0) {
            level = 'blocked';
            shouldBlock = true;
            message = `⛔ ${model.label} quota is EXHAUSTED!\nReset in: ${model.timeUntilResetFormatted}`;
        } else if (pct <= blockThreshold) {
            level = 'critical';
            shouldBlock = true;
            message = `🚨 CRITICAL: ${model.label} is at ${pct.toFixed(1)}%!\n` +
                `Continuing may trigger a cooldown penalty.\n` +
                `Reset in: ${model.timeUntilResetFormatted}`;
        } else if (pct <= warningThreshold) {
            level = 'warning';
            shouldWarn = true;
            message = `⚠️ Warning: ${model.label} is at ${pct.toFixed(1)}%\n` +
                `Reset in: ${model.timeUntilResetFormatted}`;
        }

        return { shouldWarn, shouldBlock, level, model, message };
    }

    private async showWarningModal(check: GuardCheckResult): Promise<boolean> {
        const warningKey = `${check.model.modelId}-${Math.floor(Date.now() / 60000)}`; // Per minute

        // Don't spam warnings for the same model
        if (this.dismissedWarnings.has(warningKey)) {
            return true;
        }

        const result = await vscode.window.showWarningMessage(
            check.message,
            { modal: false },
            'Continue',
            'Show Details'
        );

        if (result === 'Show Details') {
            vscode.commands.executeCommand('gravity.showStatus');
            return false;
        }

        if (result === 'Continue') {
            this.dismissedWarnings.add(warningKey);
            return true;
        }

        // Dismissed without action - allow but don't suppress future warnings
        return true;
    }

    private async showBlockModal(check: GuardCheckResult): Promise<boolean> {
        const now = Date.now();

        // Avoid spamming block modals
        if (now - this.lastBlockShown < this.blockCooldown) {
            // Show a brief status bar notification instead
            vscode.window.setStatusBarMessage(
                `$(error) Gravity: ${check.model.label} at ${check.model.remainingPercentage?.toFixed(1)}%`,
                5000
            );
            return false;
        }

        this.lastBlockShown = now;

        const resetInfo = check.model.timeUntilResetFormatted;

        const result = await vscode.window.showErrorMessage(
            check.message,
            { modal: true },
            'Proceed Anyway',
            `Wait for Reset (${resetInfo})`
        );

        if (result === 'Proceed Anyway') {
            logger.warn(LOG_CAT, `User forced through block for ${check.model.label}`);
            return true;
        }

        // User chose to wait or dismissed
        logger.info(LOG_CAT, `User blocked action for ${check.model.label}`);
        return false;
    }

    /**
     * Get a summary message for status bar tooltip
     */
    getSummaryMessage(): string {
        const state = this.guardState;

        if (!this.lastSnapshot || this.lastSnapshot.models.length === 0) {
            return 'No quota data available';
        }

        const lines: string[] = [];

        if (state.guardActive) {
            lines.push(`🛡️ Protection: Active`);
        } else {
            lines.push(`⚠️ Protection: Disabled`);
        }

        lines.push('');
        lines.push('Model Quotas:');

        for (const model of this.lastSnapshot.models) {
            const pct = model.remainingPercentage ?? 0;
            const icon = pct <= 0 ? '⛔' : pct <= this.config.blockThreshold ? '🚨' : pct <= this.config.warningThreshold ? '⚠️' : '✅';
            lines.push(`${icon} ${model.label}: ${pct.toFixed(1)}%`);
        }

        if (state.lowestQuotaModel) {
            lines.push('');
            lines.push(`Reset: ${state.lowestQuotaModel.timeUntilResetFormatted}`);
        }

        return lines.join('\n');
    }

    /**
     * Clear dismissed warnings (e.g., after quota refresh)
     */
    clearDismissedWarnings(): void {
        this.dismissedWarnings.clear();
    }
}
