/**
 * Gravity - Quota Manager Service
 */

import * as https from 'https';
import {
    QuotaSnapshot,
    ModelQuotaInfo,
    PromptCreditsInfo,
    ServerUserStatusResponse,
} from '../utils/types';
import { logger } from '../utils/logger';

const LOG_CAT = 'QuotaManager';

export class QuotaManager {
    private port: number = 0;
    private csrfToken: string = '';
    private updateCallback?: (snapshot: QuotaSnapshot) => void;
    private errorCallback?: (error: Error) => void;
    private pollingTimer?: NodeJS.Timeout;
    private lastSnapshot?: QuotaSnapshot;

    init(port: number, csrfToken: string): void {
        this.port = port;
        this.csrfToken = csrfToken;
        logger.info(LOG_CAT, `Initialized with port ${port}`);
    }

    getLastSnapshot(): QuotaSnapshot | undefined {
        return this.lastSnapshot;
    }

    private request<T>(path: string, body: object): Promise<T> {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port: this.port,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': this.csrfToken,
                },
                rejectUnauthorized: false,
                timeout: 10000,
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body) as T);
                    } catch {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(data);
            req.end();
        });
    }

    onUpdate(callback: (snapshot: QuotaSnapshot) => void): void {
        this.updateCallback = callback;
    }

    onError(callback: (error: Error) => void): void {
        this.errorCallback = callback;
    }

    startPolling(intervalMs: number): void {
        this.stopPolling();
        logger.info(LOG_CAT, `Starting polling with interval ${intervalMs}ms`);

        // Fetch immediately
        this.fetchQuota();

        // Then poll at interval
        this.pollingTimer = setInterval(() => this.fetchQuota(), intervalMs);
    }

    stopPolling(): void {
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = undefined;
            logger.info(LOG_CAT, 'Polling stopped');
        }
    }

    async fetchQuota(): Promise<QuotaSnapshot | null> {
        try {
            logger.debug(LOG_CAT, 'Fetching quota...');

            const data = await this.request<ServerUserStatusResponse>(
                '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                {
                    metadata: {
                        ideName: 'antigravity',
                        extensionName: 'antigravity',
                        locale: 'en',
                    },
                }
            );

            const snapshot = this.parseResponse(data);
            this.lastSnapshot = snapshot;

            logger.debug(LOG_CAT, 'Quota fetched:', {
                modelsCount: snapshot.models.length,
                promptCredits: snapshot.promptCredits,
                timestamp: snapshot.timestamp.toISOString(),
            });

            if (this.updateCallback) {
                this.updateCallback(snapshot);
            }

            return snapshot;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error(LOG_CAT, `Fetch error: ${err.message}`);

            if (this.errorCallback) {
                this.errorCallback(err);
            }

            return null;
        }
    }

    private parseResponse(data: ServerUserStatusResponse): QuotaSnapshot {
        const userStatus = data.userStatus;
        const planInfo = userStatus.planStatus?.planInfo;
        const availableCredits = userStatus.planStatus?.availablePromptCredits;

        let promptCredits: PromptCreditsInfo | undefined;

        if (planInfo && availableCredits !== undefined) {
            const monthly = Number(planInfo.monthlyPromptCredits);
            const available = Number(availableCredits);
            if (monthly > 0) {
                promptCredits = {
                    available,
                    monthly,
                    usedPercentage: ((monthly - available) / monthly) * 100,
                    remainingPercentage: (available / monthly) * 100,
                };
            }
        }

        const rawModels = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
        const models: ModelQuotaInfo[] = rawModels
            .filter((m) => m.quotaInfo)
            .map((m) => {
                const resetTime = new Date(m.quotaInfo!.resetTime);
                const now = new Date();
                const diff = resetTime.getTime() - now.getTime();

                const remainingFraction = m.quotaInfo!.remainingFraction;

                return {
                    label: m.label,
                    modelId: m.modelOrAlias?.model || 'unknown',
                    remainingFraction,
                    remainingPercentage: remainingFraction !== undefined ? remainingFraction * 100 : undefined,
                    isExhausted: remainingFraction === 0,
                    resetTime,
                    timeUntilReset: diff,
                    timeUntilResetFormatted: this.formatTime(diff, resetTime),
                };
            });

        return {
            timestamp: new Date(),
            promptCredits,
            models,
        };
    }

    private formatTime(ms: number, resetTime: Date): string {
        if (ms <= 0) {return 'Ready';}

        const mins = Math.ceil(ms / 60000);
        let duration = '';

        if (mins < 60) {
            duration = `${mins}m`;
        } else {
            const hours = Math.floor(mins / 60);
            const remainingMins = mins % 60;
            duration = remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
        }

        const dateStr = resetTime.toLocaleDateString(undefined, {
            day: '2-digit',
            month: '2-digit',
        });
        const timeStr = resetTime.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });

        return `${duration} (${dateStr} ${timeStr})`;
    }
}
