/**
 * Gravity - Configuration Manager
 */

import * as vscode from 'vscode';
import { GravityConfig } from '../utils/types';

export class ConfigManager {
    private readonly configSection = 'gravity';

    getConfig(): GravityConfig {
        const config = vscode.workspace.getConfiguration(this.configSection);

        return {
            enabled: config.get<boolean>('enabled', true),
            warningThreshold: config.get<number>('warningThreshold', 20),
            blockThreshold: config.get<number>('blockThreshold', 2),
            pollingInterval: config.get<number>('pollingInterval', 120) * 1000, // Convert to ms
            guardEnabled: config.get<boolean>('guardEnabled', true),
            soundEnabled: config.get<boolean>('soundEnabled', true),
            pinnedModels: config.get<string[]>('pinnedModels', []),
        };
    }

    async updateConfig<K extends keyof GravityConfig>(
        key: K,
        value: GravityConfig[K]
    ): Promise<void> {
        const config = vscode.workspace.getConfiguration(this.configSection);
        await config.update(key, value, vscode.ConfigurationTarget.Global);
    }

    onConfigChange(callback: (config: GravityConfig) => void): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration(this.configSection)) {
                callback(this.getConfig());
            }
        });
    }

    async toggleGuard(): Promise<boolean> {
        const config = this.getConfig();
        const newValue = !config.guardEnabled;
        await this.updateConfig('guardEnabled', newValue);
        return newValue;
    }

    async addPinnedModel(modelId: string): Promise<void> {
        const config = this.getConfig();
        if (!config.pinnedModels.includes(modelId)) {
            const updated = [...config.pinnedModels, modelId];
            await this.updateConfig('pinnedModels', updated);
        }
    }

    async removePinnedModel(modelId: string): Promise<void> {
        const config = this.getConfig();
        const updated = config.pinnedModels.filter((id) => id !== modelId);
        await this.updateConfig('pinnedModels', updated);
    }

    async togglePinnedModel(modelId: string): Promise<boolean> {
        const config = this.getConfig();
        const isPinned = config.pinnedModels.includes(modelId);

        if (isPinned) {
            await this.removePinnedModel(modelId);
        } else {
            await this.addPinnedModel(modelId);
        }

        return !isPinned;
    }
}
