/**
 * Gravity - Status Bar UI Manager
 */

import * as vscode from 'vscode';
import { QuotaSnapshot, ModelQuotaInfo, GuardState, GravityConfig } from '../utils/types';
import { logger } from '../utils/logger';

const LOG_CAT = 'StatusBar';

/** Model label abbreviations for compact status bar display */
const MODEL_ABBREVIATIONS: Record<string, string> = {
    'Gemini 3 Pro (High)': 'G3P-H',
    'Gemini 3 Pro (Low)': 'G3P-L',
    'Gemini 3 Flash': 'G3F',
    'Claude Sonnet 4.5': 'C-S4.5',
    'Claude Sonnet 4.5 (Thinking)': 'C-S4.5T',
    'Claude Opus 4.5 (Thinking)': 'C-O4.5T',
    'GPT-OSS 120B (Medium)': 'GPT-M',
};

function getAbbreviation(label: string): string {
    if (MODEL_ABBREVIATIONS[label]) {
        return MODEL_ABBREVIATIONS[label];
    }
    // Fallback: first letters + numbers
    return label
        .split(/[\s\-_()]+/)
        .filter(Boolean)
        .map((word) => {
            const match = word.match(/^([A-Za-z]?)(.*)$/);
            if (match) {
                return match[1].toUpperCase() + (word.match(/\d+/) || [''])[0];
            }
            return word[0]?.toUpperCase() || '';
        })
        .join('')
        .slice(0, 6);
}

export class StatusBarManager implements vscode.Disposable {
    private item: vscode.StatusBarItem;
    private lastSnapshot?: QuotaSnapshot;
    private guardState?: GuardState;
    private config?: GravityConfig;

    constructor() {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.item.command = 'gravity.showStatus';
        this.item.text = '$(rocket) Gravity';
        this.item.tooltip = 'Click to view quota status';
        this.item.show();
        logger.debug(LOG_CAT, 'Status bar initialized');
    }

    showLoading(): void {
        this.item.text = '$(sync~spin) Gravity';
        this.item.tooltip = 'Connecting to Antigravity...';
        this.item.backgroundColor = undefined;
        this.item.show();
    }

    showError(message: string): void {
        this.item.text = '$(error) Gravity';
        this.item.tooltip = `Error: ${message}\nClick for details`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.item.show();
    }

    showDisconnected(): void {
        this.item.text = '$(debug-disconnect) Gravity';
        this.item.tooltip = 'Disconnected from Antigravity\nClick to reconnect';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.show();
    }

    update(snapshot: QuotaSnapshot, guardState: GuardState, config: GravityConfig): void {
        this.lastSnapshot = snapshot;
        this.guardState = guardState;
        this.config = config;

        const pinnedModels = config.pinnedModels;
        const parts: string[] = [];

        // Guard status icon
        const guardIcon = guardState.guardActive ? '$(shield)' : '$(shield-x)';

        // Find models to display
        let modelsToShow: ModelQuotaInfo[];

        if (pinnedModels.length > 0) {
            modelsToShow = snapshot.models.filter((m) => pinnedModels.includes(m.modelId));
        } else {
            // Show the model with lowest quota
            modelsToShow = guardState.lowestQuotaModel ? [guardState.lowestQuotaModel] : [];
        }

        if (modelsToShow.length === 0) {
            // No models to show, display summary status
            this.item.text = `${guardIcon} Gravity`;
        } else {
            for (const model of modelsToShow) {
                const pct = model.remainingPercentage ?? 0;
                const statusIcon = this.getStatusIcon(pct, config);
                const abbrev = getAbbreviation(model.label);
                parts.push(`${statusIcon} ${abbrev}: ${pct.toFixed(0)}%`);
            }
            this.item.text = `${guardIcon} ${parts.join(' | ')}`;
        }

        // Set colors based on guard level
        this.applyColors(guardState.level);

        // Build tooltip
        this.item.tooltip = this.buildTooltip(snapshot, guardState, config);
        this.item.show();
    }

    private getStatusIcon(percentage: number, config: GravityConfig): string {
        if (percentage <= 0) {
            return '$(error)';
        } else if (percentage < config.blockThreshold) {
            return '$(flame)';
        } else if (percentage < config.warningThreshold) {
            return '$(warning)';
        }
        return '$(check)';
    }

    private applyColors(level: string): void {
        switch (level) {
            case 'blocked':
            case 'critical':
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                this.item.color = undefined;
                break;
            case 'warning':
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                this.item.color = undefined;
                break;
            default:
                // Green foreground for healthy state (no green background available in VS Code API)
                this.item.backgroundColor = undefined;
                this.item.color = '#89d185';
                break;
        }
    }

    private buildTooltip(
        snapshot: QuotaSnapshot,
        guardState: GuardState,
        config: GravityConfig
    ): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportThemeIcons = true;

        // Header
        md.appendMarkdown('### $(rocket) Gravity Quota Guard\n\n');

        // Guard status
        if (guardState.guardActive) {
            md.appendMarkdown('$(shield) **Protection:** Active\n\n');
        } else {
            md.appendMarkdown('$(shield-x) **Protection:** Disabled\n\n');
        }

        // Thresholds
        md.appendMarkdown(`Warning: <${config.warningThreshold}% | Block: <${config.blockThreshold}%\n\n`);

        md.appendMarkdown('---\n\n');

        // Model quotas
        md.appendMarkdown('**Model Quotas:**\n\n');

        for (const model of snapshot.models) {
            const pct = model.remainingPercentage ?? 0;
            const bar = this.drawProgressBar(pct);
            const icon = this.getStatusIcon(pct, config);

            md.appendMarkdown(`${icon} **${model.label}**\n`);
            md.appendMarkdown(`\`${bar}\` ${pct.toFixed(1)}%\n`);
            md.appendMarkdown(`$(clock) Reset: ${model.timeUntilResetFormatted}\n\n`);
        }

        // Last updated
        md.appendMarkdown('---\n\n');
        md.appendMarkdown(`$(sync) Updated: ${snapshot.timestamp.toLocaleTimeString()}\n\n`);
        md.appendMarkdown('*Click to open quota menu*');

        return md;
    }

    private drawProgressBar(percentage: number): string {
        const total = 10;
        const filled = Math.round((percentage / 100) * total);
        const empty = total - filled;
        return '▓'.repeat(filled) + '░'.repeat(empty);
    }

    getLastSnapshot(): QuotaSnapshot | undefined {
        return this.lastSnapshot;
    }

    dispose(): void {
        this.item.dispose();
        logger.debug(LOG_CAT, 'Status bar disposed');
    }
}
