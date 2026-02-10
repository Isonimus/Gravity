/**
 * Gravity - Sound Notification Utility
 * 
 * Plays OS-native alert sounds using platform-specific commands.
 * No bundled audio files needed — uses sounds already on the system.
 */

import { exec } from 'child_process';
import * as os from 'os';
import { logger } from './logger';

const LOG_CAT = 'Sound';

type SoundType = 'warning' | 'critical';

/** Platform-specific sound commands */
const SOUND_COMMANDS: Record<string, Record<SoundType, string>> = {
    linux: {
        warning: 'canberra-gtk-play -i dialog-warning --description="Gravity Warning" 2>/dev/null || pw-play --volume=0.15 /usr/share/sounds/freedesktop/stereo/dialog-warning.oga 2>/dev/null || paplay /usr/share/sounds/freedesktop/stereo/dialog-warning.oga 2>/dev/null || ffplay -nodisp -autoexit -loglevel quiet -volume 30 /usr/share/sounds/freedesktop/stereo/dialog-warning.oga 2>/dev/null',
        critical: 'canberra-gtk-play -i dialog-error --description="Gravity Alert" 2>/dev/null || pw-play --volume=0.15 /usr/share/sounds/freedesktop/stereo/dialog-error.oga 2>/dev/null || paplay /usr/share/sounds/freedesktop/stereo/dialog-error.oga 2>/dev/null || ffplay -nodisp -autoexit -loglevel quiet -volume 30 /usr/share/sounds/freedesktop/stereo/dialog-error.oga 2>/dev/null',
    },
    darwin: {
        warning: 'afplay /System/Library/Sounds/Funk.aiff',
        critical: 'afplay /System/Library/Sounds/Sosumi.aiff',
    },
    win32: {
        warning: 'powershell -c "[System.Media.SystemSounds]::Exclamation.Play()"',
        critical: 'powershell -c "[System.Media.SystemSounds]::Hand.Play()"',
    },
};

/** Cooldown tracking to avoid rapid-fire sounds */
let lastSoundTime = 0;
const SOUND_COOLDOWN_MS = 10000; // 10 seconds between sounds

/**
 * Play an OS-native alert sound.
 * Respects a cooldown to avoid spamming.
 */
export function playAlertSound(type: SoundType): void {
    const now = Date.now();
    if (now - lastSoundTime < SOUND_COOLDOWN_MS) {
        logger.debug(LOG_CAT, `Sound cooldown active, skipping ${type} sound`);
        return;
    }

    const platform = os.platform();
    const commands = SOUND_COMMANDS[platform];

    if (!commands) {
        logger.debug(LOG_CAT, `No sound commands for platform: ${platform}`);
        return;
    }

    const command = commands[type];
    logger.debug(LOG_CAT, `Playing ${type} sound on ${platform}`);

    lastSoundTime = now;

    exec(command, (error) => {
        if (error) {
            logger.debug(LOG_CAT, `Sound playback failed (non-critical): ${error.message}`);
        }
    });
}
