/**
 * Gravity - Process Finder Service
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import * as process from 'process';
import { WindowsStrategy, UnixStrategy, PlatformStrategy } from './platform_strategies';
import { ProcessInfo } from '../utils/types';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);
const LOG_CAT = 'ProcessFinder';

export class ProcessFinder {
    private strategy: PlatformStrategy;
    private processName: string;

    constructor() {
        logger.debug(LOG_CAT, `Initializing for platform: ${process.platform}, arch: ${process.arch}`);

        if (process.platform === 'win32') {
            this.strategy = new WindowsStrategy();
            this.processName = 'language_server_windows_x64.exe';
        } else if (process.platform === 'darwin') {
            this.strategy = new UnixStrategy('darwin');
            this.processName = `language_server_macos${process.arch === 'arm64' ? '_arm' : ''}`;
        } else {
            this.strategy = new UnixStrategy('linux');
            this.processName = `language_server_linux${process.arch === 'arm64' ? '_arm' : '_x64'}`;
        }

        logger.info(LOG_CAT, `Target process: ${this.processName}`);
    }

    async detectProcessInfo(maxRetries: number = 3): Promise<ProcessInfo | null> {
        logger.section(LOG_CAT, `Starting process detection (max retries: ${maxRetries})`);
        const timer = logger.timeStart('detectProcessInfo');

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            logger.debug(LOG_CAT, `Attempt ${attempt + 1}/${maxRetries}`);

            try {
                const cmd = this.strategy.getProcessListCommand(this.processName);
                logger.debug(LOG_CAT, `Executing: ${cmd}`);

                const { stdout, stderr } = await execAsync(cmd);

                if (stderr) {
                    logger.warn(LOG_CAT, `Command stderr: ${stderr}`);
                }

                logger.debug(LOG_CAT, `Raw output (${stdout.length} chars)`);

                const info = this.strategy.parseProcessInfo(stdout);

                if (info) {
                    logger.info(LOG_CAT, `Process found:`, {
                        pid: info.pid,
                        extensionPort: info.extensionPort,
                        csrfToken: `${info.csrfToken.substring(0, 8)}...`,
                    });

                    // Get listening ports
                    const ports = await this.getListeningPorts(info.pid);
                    logger.debug(LOG_CAT, `Found ${ports.length} listening port(s): [${ports.join(', ')}]`);

                    if (ports.length > 0) {
                        const validPort = await this.findWorkingPort(ports, info.csrfToken);

                        if (validPort) {
                            logger.info(LOG_CAT, `Valid API port found: ${validPort}`);
                            timer();
                            return {
                                extensionPort: info.extensionPort,
                                connectPort: validPort,
                                csrfToken: info.csrfToken,
                            };
                        } else {
                            logger.warn(LOG_CAT, 'No ports responded to health check');
                        }
                    } else {
                        logger.warn(LOG_CAT, `No listening ports found for PID ${info.pid}`);
                    }
                } else {
                    logger.warn(LOG_CAT, 'Failed to parse process info from output');
                }
            } catch (e: unknown) {
                const error = e as Error & { code?: string; killed?: boolean; signal?: string; stderr?: string };
                logger.error(LOG_CAT, `Attempt ${attempt + 1} failed:`, {
                    message: error.message,
                    code: error.code,
                    killed: error.killed,
                    signal: error.signal,
                });

                if (error.stderr) {
                    logger.error(LOG_CAT, `stderr: ${error.stderr}`);
                }
            }

            if (attempt < maxRetries - 1) {
                logger.debug(LOG_CAT, 'Waiting 500ms before retry...');
                await new Promise((r) => setTimeout(r, 500));
            }
        }

        logger.error(LOG_CAT, `Process detection failed after ${maxRetries} attempts`);
        timer();
        return null;
    }

    private async getListeningPorts(pid: number): Promise<number[]> {
        try {
            const cmd = this.strategy.getPortListCommand(pid);
            logger.debug(LOG_CAT, `Port list command: ${cmd}`);

            const { stdout, stderr } = await execAsync(cmd);

            if (stderr) {
                logger.warn(LOG_CAT, `Port list stderr: ${stderr}`);
            }

            const ports = this.strategy.parseListeningPorts(stdout, pid);
            logger.debug(LOG_CAT, `Parsed ports: [${ports.join(', ')}]`);

            return ports;
        } catch (e: unknown) {
            const error = e as Error & { code?: string };
            logger.error(LOG_CAT, 'Failed to get listening ports:', {
                message: error.message,
                code: error.code,
            });
            return [];
        }
    }

    private async findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
        for (const port of ports) {
            logger.debug(LOG_CAT, `Testing port ${port}...`);
            const isWorking = await this.testPort(port, csrfToken);

            if (isWorking) {
                logger.info(LOG_CAT, `Port ${port} is working`);
                return port;
            } else {
                logger.debug(LOG_CAT, `Port ${port} did not respond`);
            }
        }
        return null;
    }

    private testPort(port: number, csrfToken: string): Promise<boolean> {
        return new Promise((resolve) => {
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port,
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': csrfToken,
                    'Connect-Protocol-Version': '1',
                },
                rejectUnauthorized: false,
                timeout: 5000,
            };

            logger.debug(LOG_CAT, `Testing https://127.0.0.1:${port}${options.path}`);

            const req = https.request(options, (res) => {
                logger.debug(LOG_CAT, `Port ${port} responded with status ${res.statusCode}`);

                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            JSON.parse(body);
                            resolve(true);
                        } catch {
                            logger.debug(LOG_CAT, `Port ${port}: 200 but invalid JSON`);
                            resolve(false);
                        }
                    } else {
                        resolve(false);
                    }
                });
            });

            req.on('error', (err: Error & { code?: string }) => {
                logger.debug(LOG_CAT, `Port ${port} error: ${err.code || err.message}`);
                resolve(false);
            });

            req.on('timeout', () => {
                logger.debug(LOG_CAT, `Port ${port} timeout`);
                req.destroy();
                resolve(false);
            });

            req.write(JSON.stringify({ wrapper_data: {} }));
            req.end();
        });
    }
}
