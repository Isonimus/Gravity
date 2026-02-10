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
import { playAlertSound } from '../utils/sound';

const LOG_CAT = 'QuotaGuard';

export class QuotaGuard {
    private lastSnapshot?: QuotaSnapshot;
    private config: GravityConfig;
    private guardState: GuardState;
    private acknowledgments: Map<string, { level: GuardLevel, timestamp: number, percentage: number }> = new Map();
    private lastSeenPercentages: Map<string, number> = new Map();
    private lastBlockShown: number = 0;
    private readonly blockCooldown = 15000; // 15 seconds global cooldown for blocks

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
        // Detect resets: if current percentage > last seen percentage, the quota has reset
        for (const model of snapshot.models) {
            const currentPct = model.remainingPercentage ?? 100;
            const lastPct = this.lastSeenPercentages.get(model.modelId);

            if (lastPct !== undefined && currentPct >= lastPct + 2.0) {
                logger.info(LOG_CAT, `Quota reset detected for ${model.label} (${lastPct.toFixed(1)}% -> ${currentPct.toFixed(1)}%)`);
                this.acknowledgments.delete(model.modelId);
                this.acknowledgments.delete('prompt_credits'); // Also clear prompt credits ack if anything resets
            }
            this.lastSeenPercentages.set(model.modelId, currentPct);
        }

        // Special check for prompt credits
        if (snapshot.promptCredits) {
            const currentPct = snapshot.promptCredits.remainingPercentage;
            const lastPct = this.lastSeenPercentages.get('prompt_credits');
            if (lastPct !== undefined && currentPct >= lastPct + 2.0) {
                this.acknowledgments.delete('prompt_credits');
            }
            this.lastSeenPercentages.set('prompt_credits', currentPct);
        }

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

        if (!this.shouldShowAlert(check)) {
            return true;
        }

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

        // Check prompt credits if available
        if (snapshot.promptCredits) {
            const pcPct = snapshot.promptCredits.remainingPercentage;

            // Create virtual model for prompt credits
            const pcVirtualModel: ModelQuotaInfo = {
                label: 'Global Prompt Credits',
                modelId: 'prompt_credits',
                remainingPercentage: pcPct,
                isExhausted: pcPct <= 0,
                resetTime: new Date(Date.now() + 3600000), // Placeholder
                timeUntilReset: 3600000,
                timeUntilResetFormatted: 'this billing cycle',
            };

            if (pcPct < lowestQuota) {
                lowestQuota = pcPct;
                lowestQuotaModel = pcVirtualModel;
            }

            if (pcPct <= this.config.warningThreshold) {
                modelsAtRisk.push(pcVirtualModel);
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

        const atRisk: ModelQuotaInfo[] = this.lastSnapshot.models.filter((model) => {
            const pct = model.remainingPercentage ?? 100;
            return pct <= this.config.warningThreshold;
        });

        // Add prompt credits if at risk
        if (this.lastSnapshot.promptCredits) {
            const pcPct = this.lastSnapshot.promptCredits.remainingPercentage;
            if (pcPct <= this.config.warningThreshold) {
                atRisk.push({
                    label: 'Global Prompt Credits',
                    modelId: 'prompt_credits',
                    remainingPercentage: pcPct,
                    isExhausted: pcPct <= 0,
                    resetTime: new Date(Date.now() + 3600000),
                    timeUntilReset: 3600000,
                    timeUntilResetFormatted: 'this billing cycle',
                });
            }
        }

        return atRisk;
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

    private shouldShowAlert(check: GuardCheckResult): boolean {
        const ack = this.acknowledgments.get(check.model.modelId);
        if (!ack) {
            return true;
        }

        const now = Date.now();
        const levelOrder: Record<GuardLevel, number> = { 'normal': 0, 'warning': 1, 'critical': 2, 'blocked': 3 };

        // If level has worsened, ALWAYS show (e.g. Warning -> Critical)
        if (levelOrder[check.level] > levelOrder[ack.level]) {
            return true;
        }

        // For critical/blocked, we suppress indefinitely until the quota resets (handled in updateSnapshot)
        // or the level worsened (handled above).
        if (check.level === 'critical' || check.level === 'blocked') {
            return false;
        }

        // For warnings, show again if it's been more than 10 minutes or percentage dropped significantly (>5%)
        const beenLongEnough = now - ack.timestamp > 600000;
        const droppedSignificantly = (ack.percentage - (check.model.remainingPercentage ?? 0)) > 5;

        return beenLongEnough || droppedSignificantly;
    }

    private async showWarningModal(check: GuardCheckResult): Promise<boolean> {
        // Play alert sound if enabled
        if (this.config.soundEnabled) {
            playAlertSound('warning');
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

        this.acknowledgments.set(check.model.modelId, {
            level: check.level,
            timestamp: Date.now(),
            percentage: check.model.remainingPercentage ?? 0
        });

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

        // Play alert sound if enabled
        if (this.config.soundEnabled) {
            playAlertSound('critical');
        }

        const result = await vscode.window.showErrorMessage(
            check.message,
            { modal: true },
            'Proceed Anyway',
            `Wait for Reset (${resetInfo})`
        );

        this.acknowledgments.set(check.model.modelId, {
            level: check.level,
            timestamp: Date.now(),
            percentage: check.model.remainingPercentage ?? 0
        });

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
     * Clear old acknowledgments (e.g., after long time)
     */
    clearDismissedWarnings(): void {
        const now = Date.now();
        for (const [id, ack] of this.acknowledgments.entries()) {
            // Keep warnings for 1 hour maximum, but critical/blocked stay until reset (handled in updateSnapshot)
            if (ack.level === 'warning' && now - ack.timestamp > 3600000) {
                this.acknowledgments.delete(id);
            }
        }
    }
}
