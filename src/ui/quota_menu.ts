/**
 * Gravity - Quota Menu UI
 */

import * as vscode from 'vscode';
import { QuotaSnapshot, GuardState, GravityConfig } from '../utils/types';
import { ConfigManager } from '../core/config_manager';
import { logger } from '../utils/logger';

const LOG_CAT = 'QuotaMenu';

interface ModelQuickPickItem extends vscode.QuickPickItem {
    modelId?: string;
    action?: string;
}

export class QuotaMenu {
    private configManager: ConfigManager;

    constructor(configManager: ConfigManager) {
        this.configManager = configManager;
    }

    async show(
        snapshot: QuotaSnapshot | undefined,
        guardState: GuardState,
        config: GravityConfig
    ): Promise<void> {
        const quickPick = vscode.window.createQuickPick<ModelQuickPickItem>();
        quickPick.title = 'Gravity - Quota Status';
        quickPick.placeholder = 'Select a model to pin/unpin from status bar';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.canSelectMany = false;

        quickPick.items = this.buildMenuItems(snapshot, guardState, config);

        let currentActiveItem: ModelQuickPickItem | undefined;

        quickPick.onDidChangeActive((items) => {
            currentActiveItem = items[0];
        });

        quickPick.onDidAccept(async () => {
            if (!currentActiveItem) { return; }

            if (currentActiveItem.action === 'toggle_guard') {
                const newState = await this.configManager.toggleGuard();
                vscode.window.showInformationMessage(
                    `Gravity protection ${newState ? 'enabled' : 'disabled'}`
                );
                quickPick.hide();
            } else if (currentActiveItem.action === 'refresh') {
                vscode.commands.executeCommand('gravity.refresh');
                quickPick.hide();
            } else if (currentActiveItem.action === 'settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'gravity');
                quickPick.hide();
            } else if (currentActiveItem.action === 'logs') {
                vscode.commands.executeCommand('gravity.showLogs');
                quickPick.hide();
            } else if (currentActiveItem.modelId) {
                // Toggle pinned model
                const isPinned = await this.configManager.togglePinnedModel(currentActiveItem.modelId);
                logger.debug(LOG_CAT, `Model ${currentActiveItem.modelId} ${isPinned ? 'pinned' : 'unpinned'}`);

                // Refresh menu
                quickPick.items = this.buildMenuItems(snapshot, guardState, this.configManager.getConfig());
            }
        });

        quickPick.onDidHide(() => {
            quickPick.dispose();
        });

        quickPick.show();
    }

    private buildMenuItems(
        snapshot: QuotaSnapshot | undefined,
        guardState: GuardState,
        config: GravityConfig
    ): ModelQuickPickItem[] {
        const items: ModelQuickPickItem[] = [];
        const pinnedModels = config.pinnedModels;

        // Guard status action
        items.push({
            label: '',
            kind: vscode.QuickPickItemKind.Separator,
        });
        items.push({
            label: guardState.guardActive
                ? '$(shield) Protection: Active'
                : '$(shield-x) Protection: Disabled',
            description: 'Click to toggle',
            action: 'toggle_guard',
        });

        // Model quotas
        items.push({
            label: 'Model Quotas',
            kind: vscode.QuickPickItemKind.Separator,
        });

        if (snapshot && snapshot.models.length > 0) {
            for (const model of snapshot.models) {
                const pct = model.remainingPercentage ?? 0;
                const bar = this.drawProgressBar(pct);
                const isPinned = pinnedModels.includes(model.modelId);

                // Pin indicator
                const pinIcon = isPinned ? '$(pinned)' : '$(pin)';

                // Status icon based on quota level
                const statusIcon = this.getStatusIcon(pct, config);

                items.push({
                    label: `${pinIcon} ${statusIcon} ${model.label}`,
                    description: `${bar} ${pct.toFixed(1)}%`,
                    detail: `    $(clock) Reset: ${model.timeUntilResetFormatted}`,
                    modelId: model.modelId,
                });
            }
        } else {
            items.push({
                label: '$(info) No model data',
                description: 'Waiting for quota info...',
            });
        }

        // Prompt credits (if available)
        if (snapshot?.promptCredits) {
            const pc = snapshot.promptCredits;
            const bar = this.drawProgressBar(pc.remainingPercentage);

            items.push({
                label: 'Prompt Credits',
                kind: vscode.QuickPickItemKind.Separator,
            });
            items.push({
                label: `$(credit-card) ${pc.available.toLocaleString()} / ${pc.monthly.toLocaleString()}`,
                description: `${bar} ${pc.remainingPercentage.toFixed(1)}%`,
            });
        }

        // Actions
        items.push({
            label: '',
            kind: vscode.QuickPickItemKind.Separator,
        });
        items.push({
            label: '$(sync) Refresh Now',
            action: 'refresh',
        });
        items.push({
            label: '$(gear) Settings',
            action: 'settings',
        });
        items.push({
            label: '$(output) Debug Logs',
            action: 'logs',
        });

        return items;
    }

    private getStatusIcon(percentage: number, config: GravityConfig): string {
        if (percentage <= 0) {
            return '$(error)';
        } else if (percentage <= config.blockThreshold) {
            return '$(flame)';
        } else if (percentage <= config.warningThreshold) {
            return '$(warning)';
        }
        return '$(check)';
    }

    private drawProgressBar(percentage: number): string {
        const total = 10;
        const filled = Math.round((percentage / 100) * total);
        const empty = total - filled;
        return '▓'.repeat(filled) + '░'.repeat(empty);
    }
}
