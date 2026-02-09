/**
 * Gravity - Antigravity Quota Guard Extension
 * 
 * Monitors AI model quota usage and protects users from cooldown penalties.
 */

import * as vscode from 'vscode';
import { ConfigManager } from './core/config_manager';
import { ProcessFinder } from './core/process_finder';
import { QuotaManager } from './core/quota_manager';
import { QuotaGuard } from './guard/quota_guard';
import { StatusBarManager } from './ui/status_bar';
import { QuotaMenu } from './ui/quota_menu';
import { logger } from './utils/logger';

let configManager: ConfigManager;
let processFinder: ProcessFinder;
let quotaManager: QuotaManager;
let quotaGuard: QuotaGuard;
let statusBar: StatusBarManager;
let quotaMenu: QuotaMenu;
let isInitialized = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger.init(context);
    logger.section('Extension', 'Gravity - Quota Guard Activating');
    logger.info('Extension', `VS Code Version: ${vscode.version}`);
    logger.info('Extension', `Activation time: ${new Date().toISOString()}`);

    // Initialize managers
    configManager = new ConfigManager();
    processFinder = new ProcessFinder();
    quotaManager = new QuotaManager();
    const config = configManager.getConfig();
    quotaGuard = new QuotaGuard(config);
    statusBar = new StatusBarManager();
    quotaMenu = new QuotaMenu(configManager);

    context.subscriptions.push(statusBar);

    logger.debug('Extension', 'Initial config:', config);

    // Register commands
    registerCommands(context);

    // Setup quota manager callbacks
    quotaManager.onUpdate((snapshot) => {
        const currentConfig = configManager.getConfig();
        const guardState = quotaGuard.updateSnapshot(snapshot);

        logger.debug('Extension', 'Quota update received:', {
            modelsCount: snapshot.models.length,
            lowestQuota: guardState.lowestQuota.toFixed(1) + '%',
            level: guardState.level,
        });

        statusBar.update(snapshot, guardState, currentConfig);

        // Clear dismissed warnings on refresh
        quotaGuard.clearDismissedWarnings();
    });

    quotaManager.onError((err) => {
        logger.error('Extension', `Quota error: ${err.message}`);
        statusBar.showError(err.message);
    });

    // Handle config changes
    context.subscriptions.push(
        configManager.onConfigChange((newConfig) => {
            logger.info('Extension', 'Config changed:', newConfig);
            quotaGuard.updateConfig(newConfig);

            if (newConfig.enabled && isInitialized) {
                quotaManager.startPolling(newConfig.pollingInterval);
            } else if (!newConfig.enabled) {
                quotaManager.stopPolling();
            }

            // Update status bar with new config
            const snapshot = quotaManager.getLastSnapshot();
            if (snapshot) {
                statusBar.update(snapshot, quotaGuard.getState(), newConfig);
            }
        })
    );

    // Initialize extension asynchronously
    logger.debug('Extension', 'Starting async initialization...');
    initializeExtension().catch((err) => {
        logger.error('Extension', 'Failed to initialize:', err);
    });

    logger.info('Extension', 'Extension activation complete');
}

function registerCommands(context: vscode.ExtensionContext): void {
    // Refresh quota
    context.subscriptions.push(
        vscode.commands.registerCommand('gravity.refresh', () => {
            logger.info('Extension', 'Manual refresh triggered');
            vscode.window.showInformationMessage('Refreshing quota...');
            quotaManager.fetchQuota();
        })
    );

    // Show status menu
    context.subscriptions.push(
        vscode.commands.registerCommand('gravity.showStatus', () => {
            logger.debug('Extension', 'Show status menu triggered');
            const snapshot = quotaManager.getLastSnapshot();
            const state = quotaGuard.getState();
            const config = configManager.getConfig();
            quotaMenu.show(snapshot, state, config);
        })
    );

    // Toggle guard protection
    context.subscriptions.push(
        vscode.commands.registerCommand('gravity.toggleGuard', async () => {
            const newState = await configManager.toggleGuard();
            logger.info('Extension', `Guard toggled: ${newState ? 'enabled' : 'disabled'}`);
            vscode.window.showInformationMessage(
                `Gravity protection ${newState ? 'enabled' : 'disabled'}`
            );

            // Update UI
            const snapshot = quotaManager.getLastSnapshot();
            if (snapshot) {
                const guardState = quotaGuard.getState();
                guardState.guardActive = newState;
                statusBar.update(snapshot, guardState, configManager.getConfig());
            }
        })
    );

    // Show debug logs
    context.subscriptions.push(
        vscode.commands.registerCommand('gravity.showLogs', () => {
            logger.info('Extension', 'Opening debug log panel');
            logger.show();
        })
    );

    // Reconnect
    context.subscriptions.push(
        vscode.commands.registerCommand('gravity.reconnect', async () => {
            logger.info('Extension', 'Reconnect triggered');
            vscode.window.showInformationMessage('Reconnecting to Antigravity...');
            isInitialized = false;
            quotaManager.stopPolling();
            statusBar.showLoading();
            await initializeExtension();
        })
    );

    // Check quota before AI action (can be called by other extensions or keybindings)
    context.subscriptions.push(
        vscode.commands.registerCommand('gravity.checkQuota', async (): Promise<boolean> => {
            return quotaGuard.checkAndWarn();
        })
    );
}

async function initializeExtension(): Promise<void> {
    if (isInitialized) {
        logger.debug('Extension', 'Already initialized, skipping');
        return;
    }

    logger.section('Extension', 'Initializing Extension');
    const timer = logger.timeStart('initializeExtension');

    const config = configManager.getConfig();
    statusBar.showLoading();

    try {
        logger.info('Extension', 'Detecting Antigravity process...');
        const processInfo = await processFinder.detectProcessInfo();

        if (processInfo) {
            logger.info('Extension', 'Process found:', {
                extensionPort: processInfo.extensionPort,
                connectPort: processInfo.connectPort,
                csrfToken: processInfo.csrfToken.substring(0, 8) + '...',
            });

            quotaManager.init(processInfo.connectPort, processInfo.csrfToken);

            if (config.enabled) {
                logger.debug('Extension', `Starting polling with interval: ${config.pollingInterval}ms`);
                quotaManager.startPolling(config.pollingInterval);
            }

            isInitialized = true;
            logger.info('Extension', 'Initialization successful');
        } else {
            logger.error('Extension', 'Antigravity process not found');
            statusBar.showDisconnected();

            const action = await vscode.window.showErrorMessage(
                'Gravity: Could not find Antigravity process. Is it running?',
                'Retry',
                'Show Logs'
            );

            if (action === 'Retry') {
                await initializeExtension();
            } else if (action === 'Show Logs') {
                logger.show();
            }
        }
    } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.error('Extension', 'Detection failed:', {
            message: error.message,
            stack: error.stack,
        });
        statusBar.showError('Detection failed');
    }

    timer();
}

export function deactivate(): void {
    logger.info('Extension', 'Extension deactivating');
    quotaManager?.stopPolling();
    statusBar?.dispose();
}
