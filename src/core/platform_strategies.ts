/**
 * Gravity - Platform Detection Strategies
 */

import { ParsedProcessInfo } from '../utils/types';
import { logger } from '../utils/logger';

const LOG_CAT = 'Platform';

export interface PlatformStrategy {
    getProcessListCommand(processName: string): string;
    parseProcessInfo(stdout: string): ParsedProcessInfo | null;
    getPortListCommand(pid: number): string;
    parseListeningPorts(stdout: string, pid: number): number[];
}

/**
 * Windows strategy using wmic and netstat
 */
export class WindowsStrategy implements PlatformStrategy {
    getProcessListCommand(processName: string): string {
        return `wmic process where "name='${processName}'" get ProcessId,CommandLine /format:list`;
    }

    parseProcessInfo(stdout: string): ParsedProcessInfo | null {
        try {
            const lines = stdout.split('\n').filter((l) => l.trim());
            let commandLine = '';
            let pid = 0;

            for (const line of lines) {
                if (line.startsWith('CommandLine=')) {
                    commandLine = line.substring('CommandLine='.length).trim();
                } else if (line.startsWith('ProcessId=')) {
                    pid = parseInt(line.substring('ProcessId='.length).trim(), 10);
                }
            }

            if (!commandLine || !pid) {
                return null;
            }

            return this.extractFromCommandLine(commandLine, pid);
        } catch (e) {
            logger.error(LOG_CAT, 'Failed to parse Windows process info', e);
            return null;
        }
    }

    private extractFromCommandLine(cmd: string, pid: number): ParsedProcessInfo | null {
        // Extract extension port: try --extension_server_port first, then --grpc_server_port
        const portMatch = cmd.match(/--extension_server_port[=\s]+(\d+)/) ||
            cmd.match(/--grpc_server_port[=\s]+(\d+)/);

        if (!portMatch) {
            logger.warn(LOG_CAT, 'Could not find extension_server_port in command line');
            return null;
        }

        const extensionPort = parseInt(portMatch[1], 10);

        // Extract CSRF token: try --csrf_token flag first, then UUID pattern in path
        const csrfMatch = cmd.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
        const tokenMatch = csrfMatch ||
            cmd.match(/--api_server_url=https?:\/\/[^/]+\/([a-f0-9-]+)/i) ||
            cmd.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);

        const csrfToken = tokenMatch ? tokenMatch[1] : '';

        if (!csrfToken) {
            logger.warn(LOG_CAT, 'Could not find CSRF token in command line');
            return null;
        }

        return { pid, extensionPort, csrfToken };
    }

    getPortListCommand(pid: number): string {
        return `netstat -ano | findstr ${pid} | findstr LISTENING`;
    }

    parseListeningPorts(stdout: string, pid: number): number[] {
        const ports: number[] = [];
        const lines = stdout.split('\n').filter((l) => l.trim());

        for (const line of lines) {
            // Format: TCP    127.0.0.1:PORT    0.0.0.0:0    LISTENING    PID
            const match = line.match(/:(\d+)\s+.*LISTENING\s+(\d+)/i);
            if (match && parseInt(match[2], 10) === pid) {
                ports.push(parseInt(match[1], 10));
            }
        }

        return [...new Set(ports)];
    }
}

/**
 * Unix strategy (macOS/Linux) using ps and lsof
 */
export class UnixStrategy implements PlatformStrategy {
    private platform: 'darwin' | 'linux';

    constructor(platform: 'darwin' | 'linux') {
        this.platform = platform;
    }

    getProcessListCommand(processName: string): string {
        return `ps aux | grep -i "${processName}" | grep -v grep`;
    }

    parseProcessInfo(stdout: string): ParsedProcessInfo | null {
        try {
            const lines = stdout.split('\n').filter((l) => l.trim());

            for (const line of lines) {
                const result = this.parseProcessLine(line);
                if (result) {
                    return result;
                }
            }

            return null;
        } catch (e) {
            logger.error(LOG_CAT, 'Failed to parse Unix process info', e);
            return null;
        }
    }

    private parseProcessLine(line: string): ParsedProcessInfo | null {
        // ps aux format: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND...
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) { return null; }

        const pid = parseInt(parts[1], 10);
        const commandLine = parts.slice(10).join(' ');

        // Extract extension_server_port (Antigravity uses this, not grpc_server_port)
        const portMatch = commandLine.match(/--extension_server_port[=\s]+(\d+)/) ||
            commandLine.match(/--grpc_server_port[=\s]+(\d+)/);
        if (!portMatch) {
            logger.debug(LOG_CAT, 'Could not find extension_server_port in command line');
            return null;
        }

        const extensionPort = parseInt(portMatch[1], 10);

        // Extract CSRF token - first try explicit --csrf_token flag, then UUID pattern
        const csrfMatch = commandLine.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
        const tokenMatch = csrfMatch || commandLine.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        const csrfToken = tokenMatch ? tokenMatch[1] : '';

        if (!csrfToken) {
            logger.warn(LOG_CAT, 'Could not find CSRF token in command line');
            return null;
        }

        logger.debug(LOG_CAT, `Parsed: pid=${pid}, port=${extensionPort}, token=${csrfToken.substring(0, 8)}...`);
        return { pid, extensionPort, csrfToken };
    }

    getPortListCommand(pid: number): string {
        if (this.platform === 'darwin') {
            return `lsof -i -P -n | grep ${pid} | grep LISTEN`;
        }
        // Linux: use ss or netstat
        return `ss -tlnp 2>/dev/null | grep "pid=${pid}" || netstat -tlnp 2>/dev/null | grep ${pid}`;
    }

    parseListeningPorts(stdout: string, _pid: number): number[] {
        const ports: number[] = [];
        const lines = stdout.split('\n').filter((l) => l.trim());

        for (const line of lines) {
            // lsof format: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
            // NAME could be: *:PORT or 127.0.0.1:PORT
            const lsofMatch = line.match(/:(\d+)\s*\(LISTEN\)/i) || line.match(/[*:](\d+)\s/);
            if (lsofMatch) {
                ports.push(parseInt(lsofMatch[1], 10));
                continue;
            }

            // ss format: LISTEN 0 128 127.0.0.1:PORT ...
            const ssMatch = line.match(/LISTEN\s+\d+\s+\d+\s+[\d.*:]+:(\d+)/);
            if (ssMatch) {
                ports.push(parseInt(ssMatch[1], 10));
                continue;
            }

            // netstat format: tcp 0 0 127.0.0.1:PORT 0.0.0.0:* LISTEN PID/name
            const netstatMatch = line.match(/:(\d+)\s+.*LISTEN/i);
            if (netstatMatch) {
                ports.push(parseInt(netstatMatch[1], 10));
            }
        }

        return [...new Set(ports)];
    }
}
