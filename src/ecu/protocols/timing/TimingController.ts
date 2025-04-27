import { PROTOCOL, DELAYS_MS } from '../../utils/constants';
import type {
  TimingConfig,
  SendCommandFunction,
  AdaptiveTimingConfig,
} from '../../utils/types';
import { AdaptiveTimingManager } from './AdaptiveTimingManager';
import { log } from '../../../utils/logger';

/**
 * Manages protocol timing patterns and settings
 */
export class TimingController {
  private readonly sendCommand: SendCommandFunction;
  private adaptiveManager: AdaptiveTimingManager | null = null;
  private activeProtocol: PROTOCOL | null = null;
  private baseDelay: number = DELAYS_MS.COMMAND_SHORT;

  constructor(sendCommand: SendCommandFunction) {
    this.sendCommand = sendCommand;
  }

  /**
   * Configures timing for a specific protocol
   */
  async configureForProtocol(
    protocol: PROTOCOL,
    config: TimingConfig,
  ): Promise<void> {
    this.activeProtocol = protocol;

    // Initialize adaptive timing if config provided
    if (config.adaptiveMode !== undefined) {
      const adaptiveConfig: AdaptiveTimingConfig = {
        mode: config.adaptiveMode,
        timeout: config.responseTimeoutMs ?? DELAYS_MS.TIMEOUT_NORMAL_MS,
        startDelay: DELAYS_MS.ADAPTIVE_START,
        minDelay: DELAYS_MS.ADAPTIVE_MIN,
        maxDelay: DELAYS_MS.ADAPTIVE_MAX,
        increment: DELAYS_MS.ADAPTIVE_INC,
        decrement: DELAYS_MS.ADAPTIVE_DEC,
      };

      this.adaptiveManager = new AdaptiveTimingManager(adaptiveConfig);

      // Apply adaptive timing settings
      await this.applyAdaptiveTiming();
    }

    // Set base protocol timing parameters
    this.baseDelay = this.calculateBaseDelay(protocol);
  }

  /**
   * Applies adaptive timing settings to the ELM adapter
   */
  private async applyAdaptiveTiming(): Promise<void> {
    if (!this.adaptiveManager) {
      return;
    }

    try {
      // Set adaptive timing mode
      const atCommand = this.adaptiveManager.getAdaptiveCommand();
      await this.sendCommand(atCommand, 1000);
      await this.delay(DELAYS_MS.COMMAND_SHORT);

      // Set initial timeout
      const timeoutHex = this.adaptiveManager.getTimeoutHex();
      await this.sendCommand(`ATST${timeoutHex}`, 1000);
      await this.delay(DELAYS_MS.COMMAND_SHORT);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      void log.warn('[TimingController] Error applying adaptive timing:', {
        error: errorMsg,
      });
    }
  }

  /**
   * Calculates base delay for a protocol
   */
  private calculateBaseDelay(protocol: PROTOCOL): number {
    // Use protocol-specific base delays
    switch (protocol) {
      case PROTOCOL.ISO_15765_4_CAN_11BIT_500K:
      case PROTOCOL.ISO_15765_4_CAN_29BIT_500K:
        return Math.floor(DELAYS_MS.COMMAND_SHORT * 0.6); // Faster for CAN 500K

      case PROTOCOL.ISO_15765_4_CAN_11BIT_250K:
      case PROTOCOL.ISO_15765_4_CAN_29BIT_250K:
        return Math.floor(DELAYS_MS.COMMAND_SHORT * 0.8); // Slightly slower for CAN 250K

      case PROTOCOL.ISO_14230_4_KWP:
      case PROTOCOL.ISO_14230_4_KWP_FAST:
        return Math.floor(DELAYS_MS.COMMAND_SHORT * 1.1); // Slightly longer for KWP

      case PROTOCOL.ISO_9141_2:
        return Math.floor(DELAYS_MS.COMMAND_SHORT * 1.2); // Longer for ISO9141

      default:
        return DELAYS_MS.COMMAND_SHORT; // Default delay
    }
  }

  /**
   * Gets current command delay, incorporating adaptive timing if enabled
   */
  getCurrentDelay(): number {
    return this.adaptiveManager?.getCurrentDelay() ?? this.baseDelay;
  }

  /**
   * Adjusts timing based on command result
   */
  adjustTiming(success: boolean): void {
    this.adaptiveManager?.adjustTiming(success);
  }

  /**
   * Resets timing to initial state
   */
  async reset(): Promise<void> {
    if (this.adaptiveManager) {
      this.adaptiveManager.reset();
      await this.applyAdaptiveTiming();
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
