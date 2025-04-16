import { PROTOCOL_DESCRIPTIONS } from './constants';

import type { SendCommandFunction } from './types';

/**
 * Utility class with helper methods from the original ECUDataRetriever and OBDUtils
 */
class ECURetrieverUtils {
  /**
   * Map between protocol number and protocol description
   */
  static getProtocolDescription(protocolNum: number): string {
    return PROTOCOL_DESCRIPTIONS[protocolNum] || 'Unknown Protocol';
  }

  /**
   * Determine if protocol is CAN based on protocol number
   */
  static isCanProtocol(protocolNum: number): boolean {
    // Protocols 6-20 are CAN-based
    return protocolNum >= 6 && protocolNum <= 20;
  }

  /**
   * Get the appropriate flow control header for a protocol
   */
  static getFlowControlHeader(
    _headerFormat: string,
    protocolNum: number,
  ): string {
    if (protocolNum >= 6 && protocolNum <= 20) {
      // CAN protocols
      if (protocolNum % 2 === 0) {
        // 11-bit CAN
        return '7E0';
      } else {
        // 29-bit CAN
        return '18DA10F1';
      }
    }

    return '';
  }

  /**
   * Try to recover from communication errors
   * @param sendCommand - Function to send commands to the adapter
   */
  static async recoverFromErrors(
    sendCommand: SendCommandFunction,
  ): Promise<boolean> {
    try {
      // Reset the adapter
      await sendCommand('ATZ');
      await new Promise<void>(resolve => {
        setTimeout(() => resolve(), 1000);
      });

      // Try auto protocol
      await sendCommand('ATSP0');
      await new Promise<void>(resolve => {
        setTimeout(() => resolve(), 300);
      });

      // Configure adapter with basic settings
      const setupCommands = ['ATE0', 'ATL0', 'ATS0', 'ATH1'];

      for (const cmd of setupCommands) {
        await sendCommand(cmd);
        await new Promise<void>(resolve => {
          setTimeout(() => resolve(), 100);
        });
      }

      // Try to wake up ECU
      await sendCommand('0100');

      return true;
    } catch (error) {
      console.error('Error during recovery attempt:', error);

      return false;
    }
  }
}

export { ECURetrieverUtils };
