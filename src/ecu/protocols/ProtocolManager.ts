import { log } from '../../utils/logger';
import {
  ELM_COMMANDS,
  DELAYS_MS,
  PROTOCOL,
  PROTOCOL_DESCRIPTIONS,
  PROTOCOL_TRY_ORDER,
  STANDARD_PIDS, // Import standard PIDs
} from '../utils/constants';

import type { SendCommandFunction } from '../utils/types';

// Use the standard PID 0100 (Supported PIDs [01-20]) for protocol testing
const PROTOCOL_TEST_COMMAND = STANDARD_PIDS.SUPPORTED_PIDS_1;

/**
 * Manages OBD protocol detection, initialization, and communication setup
 *
 * This class handles the complex process of detecting the appropriate OBD protocol
 * for a vehicle and configuring the ELM adapter accordingly. It implements intelligent
 * protocol detection strategies based on priority order and vehicle compatibility.
 *
 * Key features:
 * - Auto protocol detection
 * - Specific protocol testing in priority order
 * - Protocol validation with standard test commands
 * - ECU address detection
 * - Protocol-specific adapter configuration
 *
 * Based on logic from ElmProtocol, ElmProtocolHelper, ElmProtocolInit.
 *
 * @example
 * ```typescript
 * // Create a protocol manager with a sendCommand function
 * const protocolManager = new ProtocolManager(sendCommand);
 *
 * // Attempt automatic protocol detection
 * const result = await protocolManager.detectProtocol();
 *
 * if (result.success) {
 *   console.log(`Detected protocol: ${result.protocolName} (${result.protocol})`);
 *   console.log(`ECU addresses: ${result.ecuAddresses.join(', ')}`);
 * } else {
 *   console.error(`Protocol detection failed: ${result.error}`);
 * }
 * ```
 */
export class ProtocolManager {
  /** Function to send commands to the OBD adapter */
  private readonly sendCommand: SendCommandFunction;

  /**
   * Creates a new ProtocolManager instance
   *
   * @param sendCommand - Function to send commands to the OBD adapter
   */
  constructor(sendCommand: SendCommandFunction) {
    this.sendCommand = sendCommand;
  }

  /**
   * Helper method to create a delay
   *
   * @param ms - Delay duration in milliseconds
   * @returns Promise that resolves after the specified delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Gets the currently active protocol number from the ELM327 adapter
   *
   * Sends the ATDPN command to retrieve the currently active protocol
   * number from the adapter. This is useful for verifying protocol
   * settings or checking if a protocol was automatically detected.
   *
   * @returns Promise resolving to the active protocol as a PROTOCOL enum value, or null if unknown
   * @example
   * ```typescript
   * const protocol = await protocolManager.getCurrentProtocolNumber();
   * if (protocol !== null) {
   *   console.log(`Active protocol: ${PROTOCOL_DESCRIPTIONS[protocol]}`);
   * } else {
   *   console.log("No active protocol detected");
   * }
   * ```
   */
  async getCurrentProtocolNumber(): Promise<PROTOCOL | null> {
    await log.debug(
      '[ProtocolManager] Querying current protocol number (ATDPN)...',
    );
    try {
      const response = await this.sendCommand(ELM_COMMANDS.GET_PROTOCOL_NUM);
      const protocolNum = this.extractProtocolNumber(response);
      if (protocolNum !== null) {
        await log.debug(
          `[ProtocolManager] Current protocol number: ${protocolNum}`,
        );
      } else {
        await log.warn(
          `[ProtocolManager] Could not determine current protocol number from response: ${response ?? 'null'}`,
        );
      }
      // Cast to PROTOCOL enum type
      return protocolNum as PROTOCOL | null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.error(
        '[ProtocolManager] Error getting current protocol number:',
        { error: errorMsg },
      );
      return null;
    }
  }

  private isValidProtocolResponse(response: string | null): boolean {
    if (!response) return false;
    const upper = response.toUpperCase().trim();

    // More generous validation including initial response formats
    // and adapter-specific patterns like command+62
    return (
      upper.includes('41') || // Standard OBD response
      upper.includes('7E8') || // CAN ECU address
      upper.includes('7E9') || // Additional CAN ECU
      upper.includes('7E0') || // More CAN addresses
      upper.includes('007F') || // Valid PID response pattern
      upper.includes('7FFFFF') || // Common response pattern for 0100
      upper.includes('0100') || // Raw command echo is valid during init
      upper.includes('62') || // ELM327 v1.5+ acknowledgment pattern
      (upper.endsWith('62') && upper.length >= 4) // Command echo with 62 suffix is valid during init
    );
  }

  private isCommandSuccessful(
    command: string,
    response: string | null,
  ): boolean {
    if (!response) return false;
    const upper = response.toUpperCase().trim();

    // Check for command echo with 62 suffix (e.g., "ATE062")
    if (upper === `${command}62`) return true;

    // Standard success patterns
    return (
      upper.includes('OK') ||
      upper.includes(command) || // Command echo
      upper.includes('ELM') ||
      upper.includes('ATZ') ||
      upper.includes('SEARCHING') ||
      upper.includes('CONNECTING') ||
      upper.includes('BUS INIT') ||
      upper.includes('BUS') ||
      // Additional valid patterns from old code
      (upper.includes('41') && !upper.includes('ERROR')) || // Valid OBD response
      (upper.includes('7E') && upper.length >= 4) || // Valid CAN response
      (upper.endsWith('62') && upper.length >= 4) // Valid command acknowledgment
    );
  }

  private async sendProtocolTestCommand(
    maxRetries: number = 3,
  ): Promise<string | null> {
    let attempts = 0;
    let lastResponse: string | null = null;

    while (attempts < maxRetries) {
      const testResponse = await this.sendCommand(PROTOCOL_TEST_COMMAND);
      lastResponse = testResponse;

      if (!testResponse) {
        attempts++;
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        continue;
      }

      const upper = testResponse.toUpperCase();

      // If we get SEARCHING or command+62 pattern, retry
      if (upper.includes('SEARCHING') || upper.endsWith('62')) {
        await log.debug(
          `[ProtocolManager] Got SEARCHING/62 response on attempt ${attempts + 1}, retrying...`,
        );
        await this.delay(DELAYS_MS.COMMAND_MEDIUM);
        attempts++;
        continue;
      }

      // Check for valid response patterns
      if (this.isValidProtocolResponse(testResponse)) {
        return testResponse;
      }

      // If we got an explicit error
      if (
        upper.includes('ERROR') ||
        upper.includes('UNABLE') ||
        upper.includes('?') ||
        upper.includes('CAN ERROR')
      ) {
        return null;
      }

      attempts++;
      await this.delay(DELAYS_MS.COMMAND_SHORT);
    }

    // Consider command+62 responses as potentially successful
    if (lastResponse && lastResponse.endsWith('62')) {
      return lastResponse;
    }

    // If our last response was somewhat valid but didn't match strict criteria
    if (
      lastResponse &&
      (lastResponse.includes('41') || lastResponse.includes('7F'))
    ) {
      return lastResponse;
    }

    await log.warn(
      `[ProtocolManager] Test command failed after ${maxRetries} attempts`,
    );
    return null;
  }

  async detectAndSetProtocol(): Promise<{
    protocol: PROTOCOL;
    name: string;
  } | null> {
    await log.debug(
      '[ProtocolManager] Starting protocol detection sequence...',
    );

    // Step 1: Try Auto Protocol (ATSP0) first, includes verification
    try {
      await log.debug('[ProtocolManager] Trying ATSP0 (Auto)...');
      // Set initial timing configuration for auto protocol
      await this.setInitialTimingAndProtocol(PROTOCOL.AUTO);
      
      const autoSetResponse = await this.sendCommand(
        ELM_COMMANDS.AUTO_PROTOCOL,
      );
      await this.delay(DELAYS_MS.COMMAND_MEDIUM);

      // More liberal response validation helper
      if (autoSetResponse) {
        const upper = autoSetResponse
          .toUpperCase()
          .replace(/[\r\n>]/g, '')
          .trim();
        if (
          upper.includes('OK') ||
          upper.includes('ELM') ||
          upper.includes('ATZ') ||
          upper.includes('SEARCHING') ||
          upper.includes('4100') ||
          upper.includes('7E') ||
          upper.includes('CONNECTING') ||
          upper.includes('BUS')
        ) {
          // Double the delay for auto protocol
          await this.delay(DELAYS_MS.PROTOCOL_SWITCH * 2); 

          // Additional initialization for auto protocol
          await this.sendCommand('ATH1');          await this.sendCommand('ATCAF1');          await this.delay(DELAYS_MS.COMMAND_MEDIUM);

          const verifyResponse = await this.sendProtocolTestCommand(4);
          if (verifyResponse) {
            const protocolNum = await this.getCurrentProtocolNumber();
            if (protocolNum !== null && protocolNum !== PROTOCOL.AUTO) {
              await log.info(
                '[ProtocolManager] Auto protocol verified with response:',
                verifyResponse,
              );
              const protocolName =
                PROTOCOL_DESCRIPTIONS[protocolNum] ?? `Protocol ${protocolNum}`;
              return { protocol: protocolNum, name: protocolName };
            }
          }
        }
      }
      
      // Reset protocol if auto failed
      await this.resetProtocol();
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.error('[ProtocolManager] Error during Auto protocol attempt:', {
        error: errorMsg,
      });
      await this.resetProtocol();
    }

    // Step 2: Manual Protocol Detection if Auto failed
    await log.debug(
      '[ProtocolManager] Auto-detect failed or inconclusive. Starting manual protocol testing...',
    );

    for (const protocol of PROTOCOL_TRY_ORDER) {
      if (Number(protocol) === PROTOCOL.AUTO) continue;

      const protocolNumHex = protocol.toString(16).toUpperCase();
      const protocolName =
        PROTOCOL_DESCRIPTIONS[protocol] ?? `Protocol ${protocolNumHex}`;
      await log.debug(
        `[ProtocolManager] Trying protocol: ${protocolName} (${protocolNumHex})...`,
      );

      try {
        // Reset protocol and set timing before trying new protocol
        await this.resetProtocol();
        await this.setInitialTimingAndProtocol(protocol);

        // Try Protocol command (ATTP)
        const tryCmd = `${ELM_COMMANDS.TRY_PROTOCOL_PREFIX}${protocolNumHex}`;
        const tryResponse = await this.sendCommand(tryCmd, 10000);

        // More lenient response checking with command+62 pattern
        if (tryResponse) {
          if (this.isCommandSuccessful(tryCmd, tryResponse)) {
            // Give protocol time to initialize
            await this.delay(DELAYS_MS.PROTOCOL_SWITCH);

            // Configure CAN settings if applicable
            if (protocol >= PROTOCOL.ISO_15765_4_CAN_11BIT_500K && protocol <= PROTOCOL.ISO_15765_4_CAN_29BIT_250K_8) {
              await this.sendCommand('ATCAF1');
              await this.delay(DELAYS_MS.COMMAND_SHORT);
              
              // Set appropriate CAN headers based on protocol
              if (protocol === PROTOCOL.ISO_15765_4_CAN_11BIT_500K || protocol === PROTOCOL.ISO_15765_4_CAN_11BIT_250K) {
                await this.sendCommand('ATSH7DF'); // Standard 11-bit broadcast ID
              } else {
                await this.sendCommand('ATSH18DB33F1'); // Extended 29-bit broadcast ID
              }
              await this.delay(DELAYS_MS.COMMAND_SHORT);
            }

            // Send test command to verify actual communication
            const testResponse = await this.sendProtocolTestCommand();
            if (testResponse && !this.isResponseError(testResponse)) {
              const testUpper = testResponse.toUpperCase();
              if (
                !testUpper.includes('ERROR') &&
                !testUpper.includes('UNABLE') &&
                !testUpper.includes('?')
              ) {
                await log.info(
                  `[ProtocolManager] Protocol ${protocolName} appears to be working`,
                );

                // Set it permanently
                const setCmd = `${ELM_COMMANDS.SET_PROTOCOL_PREFIX}${protocolNumHex}`;
                await this.sendCommand(setCmd, 2000);
                return { protocol, name: protocolName };
              }
            }
          }
        }
      } catch (error) {
        await log.error(`[ProtocolManager] Error testing ${protocolName}`, {
          error,
        });
      }
    }

    await log.error(
      '[ProtocolManager] Protocol detection failed - No working protocol found after all attempts.',
    );
    return null; // No protocol found
  }

  /**
   * Configures adapter with protocol-specific settings
   *
   * This method applies optimal settings for the detected protocol to ensure
   * reliable communication with the vehicle. It configures:
   *
   * 1. Adaptive timing settings (ATAT)
   *    - Uses more aggressive timing (ATAT2) for KWP protocols
   *    - Uses standard timing (ATAT1) for other protocols
   *
   * 2. Header settings (ATH)
   *    - Enables headers for CAN protocols (ATH1)
   *    - Disables headers for non-CAN protocols (ATH0)
   *
   * 3. CAN protocol specific settings
   *    - Automatic formatting (ATCAF1/0)
   *    - Flow control configuration for multi-frame messages
   *
   * Note: This method assumes basic initialization (ATE0, ATL0, ATS0)
   * has already been performed.
   *
   * Based on ElmProtocol.initializeDevice and configureForProtocol logic.
   *
   * @param protocol - The detected protocol number from PROTOCOL enum
   * @example
   * ```typescript
   * // After successful protocol detection
   * if (protocolInfo) {
   *   // Apply protocol-specific settings
   *   await protocolManager.configureProtocolSettings(protocolInfo.protocol);
   *
   *   // Now ready for vehicle communication
   *   const vinResponse = await sendCommand("0902", 5000);
   * }
   * ```
   */
  async configureProtocolSettings(protocol: PROTOCOL | null): Promise<void> {
    if (protocol === null) {
      await log.warn(
        '[ProtocolManager] Cannot configure settings: No active protocol.',
      );
      return;
    }
    await log.debug(
      `[ProtocolManager] Configuring settings for protocol: ${protocol}`,
    );
    try {
      // Reset all settings first
      await this.sendCommand('ATZ');
      await this.delay(DELAYS_MS.RESET);

      // Basic settings
      await this.sendCommand('ATE0'); // Echo off
      await this.sendCommand('ATL0'); // Line feeds off
      await this.sendCommand('ATS0'); // Spaces off
      await this.delay(DELAYS_MS.COMMAND_SHORT);

      // Set Adaptive Timing
      const adaptTimingCmd =
        protocol === PROTOCOL.ISO_14230_4_KWP ||
        protocol === PROTOCOL.ISO_14230_4_KWP_FAST
          ? ELM_COMMANDS.ADAPTIVE_TIMING_2 // Use ATAT2 for KWP
          : ELM_COMMANDS.ADAPTIVE_TIMING_1; // Use ATAT1 for others
      await log.debug(
        `[ProtocolManager] Setting adaptive timing (${adaptTimingCmd})`,
      );
      await this.sendCommand(adaptTimingCmd);
      await this.delay(DELAYS_MS.COMMAND_SHORT);

      // Set Headers and CAN configuration
      const isCan =
        protocol >= PROTOCOL.ISO_15765_4_CAN_11BIT_500K &&
        protocol <= PROTOCOL.ISO_15765_4_CAN_29BIT_250K_8;

      if (isCan) {
        // For CAN protocols, we need headers on and proper flow control
        await log.debug('[ProtocolManager] Configuring CAN protocol settings');
        await this.sendCommand(ELM_COMMANDS.HEADERS_ON);
        await this.sendCommand(ELM_COMMANDS.CAN_AUTO_FORMAT_ON);

        // Set flow control IDs based on protocol type
        const is11Bit =
          protocol === PROTOCOL.ISO_15765_4_CAN_11BIT_500K ||
          protocol === PROTOCOL.ISO_15765_4_CAN_11BIT_250K;

        if (is11Bit) {
          await this.sendCommand('ATFCSH7E0'); // Flow control send header
          await this.sendCommand('ATFCSD300000'); // Flow control data
          await this.sendCommand('ATFCSM1'); // Flow control mode
        } else {
          await this.sendCommand('ATFCSH18DA10F1'); // Extended CAN flow control header
          await this.sendCommand('ATFCSD300000');
          await this.sendCommand('ATFCSM1');
        }
      } else {
        // For non-CAN protocols
        await log.debug(
          '[ProtocolManager] Configuring non-CAN protocol settings',
        );
        await this.sendCommand(ELM_COMMANDS.HEADERS_OFF);
        await this.sendCommand(ELM_COMMANDS.CAN_AUTO_FORMAT_OFF);
      }
      await this.delay(DELAYS_MS.COMMAND_SHORT);

      await log.debug(
        `[ProtocolManager] Basic settings configured for protocol ${protocol}.`,
      );
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.warn(
        '[ProtocolManager] Error during protocol settings configuration:',
        { error: errorMsg },
      );
    }
  }

  private extractProtocolNumber(response: string | null): number | null {
    if (!response) return null;
    const match = response.match(/[AP]\d+/);
    return match ? parseInt(match[0].substring(1)) : null;
  }

  private isResponseError(response: string): boolean {
    if (!response) return true;
    
    // Common error patterns found in both old and new implementations
    const errorPatterns = [
      'ERROR',
      'UNABLE TO CONNECT',
      'NO DATA',
      'CAN ERROR',
      'BUS ERROR',
      'BUFFER FULL',
      'BUS INIT: ERROR',
      'DATA ERROR',
      'STOPPED',
      '?'
    ];
    
    const upper = response.toUpperCase();
    return errorPatterns.some(pattern =>
      upper.includes(pattern)
    ) || upper === '010062'; // Special case: bare command echo with 62 suffix is considered an error
  }

  private async setInitialTimingAndProtocol(protocol: PROTOCOL): Promise<void> {
    // Set timeout to 4*62ms (~250ms) which is more reliable for initialization
    await this.sendCommand('ATST62');
    await this.delay(DELAYS_MS.COMMAND_SHORT);
    
    // Set response timeout multiplier for slow ECUs (00 = no timeout)
    await this.sendCommand('ATAT0');
    await this.delay(DELAYS_MS.COMMAND_SHORT);

    // Set the protocol but allow searching
    const protocolHex = protocol.toString(16).toUpperCase();
    await this.sendCommand(`ATSP${protocolHex}`);
    await this.delay(DELAYS_MS.PROTOCOL_SWITCH * 2); // Double delay for protocol switch
  }

  private async resetProtocol(): Promise<void> {
    // Close any active protocol first
    await this.sendCommand(ELM_COMMANDS.PROTOCOL_CLOSE);
    await this.delay(DELAYS_MS.PROTOCOL_SWITCH);
    
    // Reset adapter
    await this.sendCommand('ATZ');
    await this.delay(DELAYS_MS.RESET);
    
    // Base configuration
    await this.sendCommand('ATE0'); // Echo off
    await this.sendCommand('ATL0'); // Line feeds off
    await this.sendCommand('ATS0'); // Spaces off
    await this.sendCommand('ATH1'); // Headers on
    await this.delay(DELAYS_MS.COMMAND_MEDIUM);
  }
}
