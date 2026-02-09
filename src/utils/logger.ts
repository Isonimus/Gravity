/**
 * Gravity - Logger Utility
 */

import * as vscode from 'vscode';

class Logger {
    private outputChannel: vscode.OutputChannel | undefined;
    private context: vscode.ExtensionContext | undefined;

    init(context: vscode.ExtensionContext): void {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('Gravity');
    }

    private formatMessage(category: string, message: string): string {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${category}] ${message}`;
    }

    private log(level: string, category: string, message: string, data?: unknown): void {
        if (!this.outputChannel) {
            console.log(`[${level}] [${category}] ${message}`, data);
            return;
        }

        let output = this.formatMessage(category, `[${level}] ${message}`);
        if (data !== undefined) {
            output += '\n' + JSON.stringify(data, null, 2);
        }
        this.outputChannel.appendLine(output);
    }

    info(category: string, message: string, data?: unknown): void {
        this.log('INFO', category, message, data);
    }

    warn(category: string, message: string, data?: unknown): void {
        this.log('WARN', category, message, data);
    }

    error(category: string, message: string, data?: unknown): void {
        this.log('ERROR', category, message, data);
    }

    debug(category: string, message: string, data?: unknown): void {
        this.log('DEBUG', category, message, data);
    }

    section(category: string, title: string): void {
        if (!this.outputChannel) {return;}
        this.outputChannel.appendLine('');
        this.outputChannel.appendLine('═'.repeat(60));
        this.outputChannel.appendLine(this.formatMessage(category, title));
        this.outputChannel.appendLine('═'.repeat(60));
    }

    timeStart(label: string): () => void {
        const start = Date.now();
        return () => {
            const elapsed = Date.now() - start;
            this.debug('Timer', `${label}: ${elapsed}ms`);
        };
    }

    show(): void {
        this.outputChannel?.show();
    }

    dispose(): void {
        this.outputChannel?.dispose();
    }
}

export const logger = new Logger();
