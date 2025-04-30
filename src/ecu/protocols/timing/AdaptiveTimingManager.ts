import type { AdaptiveTimingConfig } from '../../utils/types';
import { log } from '../../../utils/logger';

/**
 * Manages adaptive timing adjustments for OBD communication
 */
export class AdaptiveTimingManager {
  private currentDelay: number;
  private readonly config: AdaptiveTimingConfig;

  constructor(config: AdaptiveTimingConfig) {
    this.config = config;
    this.currentDelay = config.startDelay;
  }

  /**
   * Gets the current delay value
   */
  getCurrentDelay(): number {
    return this.currentDelay;
  }

  /**
   * Adjusts timing based on command success/failure
   * @param success Whether the last command was successful
   * @returns The new delay value
   */
  adjustTiming(success: boolean): number {
    const oldDelay = this.currentDelay;

    if (success) {
      // Decrease delay for successful commands
      this.currentDelay = Math.max(
        this.config.minDelay,
        this.currentDelay - this.config.decrement,
      );
    } else {
      // Increase delay for failed commands
      this.currentDelay = Math.min(
        this.config.maxDelay,
        this.currentDelay + this.config.increment,
      );
    }

    if (oldDelay !== this.currentDelay) {
      void log.debug('[AdaptiveTiming] Adjusted timing', {
        oldDelay,
        newDelay: this.currentDelay,
        success,
      });
    }

    return this.currentDelay;
  }

  /**
   * Resets timing to initial state
   */
  reset(): void {
    this.currentDelay = this.config.startDelay;
    void log.debug('[AdaptiveTiming] Reset to initial delay', {
      delay: this.currentDelay,
    });
  }

  /**
   * Gets the ELM327 hex timeout value based on current delay
   * Converts ms to 4ms units used by ELM327 ATST command
   */
  getTimeoutHex(): string {
    // Add buffer to current delay for timeout
    const timeoutMs = this.currentDelay * 1.5;
    // Convert to 4ms units and format as hex
    const timeoutHex = Math.ceil(timeoutMs / 4)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
    return timeoutHex;
  }

  /**
   * Gets the ELM327 AT command for current mode
   */
  getAdaptiveCommand(): string {
    return `ATAT${this.config.mode}`;
  }
}
