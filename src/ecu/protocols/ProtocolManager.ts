import { log } from '../../utils/logger';
import {
  ELM_COMMANDS,
  DELAYS_MS,
  PROTOCOL,
  PROTOCOL_DESCRIPTIONS,
  PROTOCOL_TRY_ORDER,
  RESPONSE_KEYWORDS,
  STANDARD_PIDS, // Import standard PIDs
} from '../utils/constants';
import {
  cleanResponse,
  extractProtocolNumber,
  isResponseError,
  isResponseOk,
} from '../utils/helpers';

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
      // Use a moderate timeout for protocol query
      const response = await this.sendCommand(
        ELM_COMMANDS.GET_PROTOCOL_NUM,
        2000,
      );
      const protocolNum = extractProtocolNumber(response);
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
    return (
      upper.includes('41') ||      // Standard OBD response
      upper.includes('7E8') ||     // CAN ECU address
      upper.includes('7E9') ||     // Additional CAN ECU
      upper.includes('7E0') ||     // More CAN addresses
      upper.includes('007F') ||    // Valid PID response pattern
      upper.includes('7FFFFF')     // Common response pattern for 0100
    );
  }

  private async sendProtocolTestCommand(maxRetries: number = 3, timeout: number = 5000): Promise<string | null> {
    let attempts = 0;
    let lastResponse: string | null = null;
    
    while (attempts < maxRetries) {
      const testResponse = await this.sendCommand(PROTOCOL_TEST_COMMAND, timeout);
      lastResponse = testResponse;
      
      if (!testResponse) {
        attempts++;
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        continue;
      }

      const upper = testResponse.toUpperCase();
      
      // If we get SEARCHING, wait longer and retry
      if (upper.includes('SEARCHING')) {
        await log.debug(`[ProtocolManager] Got SEARCHING response on attempt ${attempts + 1}, retrying...`);
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

    // If our last response was somewhat valid but didn't match strict criteria
    if (lastResponse && 
        (lastResponse.includes('41') || lastResponse.includes('7F'))) {
      return lastResponse;
    }

    await log.warn(`[ProtocolManager] Test command failed after ${maxRetries} attempts`);
    return null;
  }

  async detectAndSetProtocol(): Promise<{ protocol: PROTOCOL; name: string; } | null> {
    await log.debug(
      '[ProtocolManager] Starting protocol detection sequence...',
    );

    // Step 1: Try Auto Protocol (ATSP0) first, includes verification
    try {
      await log.debug('[ProtocolManager] Trying ATSP0 (Auto)...');
      const autoSetResponse = await this.sendCommand(
        ELM_COMMANDS.AUTO_PROTOCOL,
        5000,
      ); // Timeout for ATSP0
      await this.delay(DELAYS_MS.COMMAND_MEDIUM);

      // More liberal response validation helper
      if (autoSetResponse) {
        const upper = autoSetResponse.toUpperCase().replace(/[\r\n>]/g, '').trim();
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
          await this.delay(DELAYS_MS.PROTOCOL_SWITCH * 2); // Double the delay for auto protocol
          
          const verifyResponse = await this.sendProtocolTestCommand(4, 8000); // More retries and longer timeout
          
          if (verifyResponse) {
            const protocolNum = await this.getCurrentProtocolNumber();
            if (protocolNum !== null && protocolNum !== PROTOCOL.AUTO) {
              await log.info(`[ProtocolManager] Auto protocol verified with response: ${verifyResponse}`);
              const protocolName = PROTOCOL_DESCRIPTIONS[protocolNum] ?? `Protocol ${protocolNum}`;
              return { protocol: protocolNum, name: protocolName };
            }
          }
        }
      }
      // Close protocol if auto failed, before trying manual
      try {
        await log.debug(
          '[ProtocolManager] Closing protocol after failed auto-attempt (ATPC)...',
        );
        // Remove timeout from ATPC command
        await this.sendCommand(ELM_COMMANDS.PROTOCOL_CLOSE);
        await this.delay(DELAYS_MS.PROTOCOL_SWITCH);
      } catch {
        /* Ignore cleanup error */
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.error('[ProtocolManager] Error during Auto protocol attempt:', {
        error: errorMsg,
      });
      try {
        await log.debug(
          '[ProtocolManager] Closing protocol after error during auto-attempt (ATPC)...',
        );
        await this.sendCommand(ELM_COMMANDS.PROTOCOL_CLOSE);
        await this.delay(DELAYS_MS.PROTOCOL_SWITCH);
      } catch {
        /* Ignore cleanup error */
      }
    }

    // Step 2: Manual Protocol Detection if Auto failed
    await log.debug(
      '[ProtocolManager] Auto-detect failed or inconclusive. Starting manual protocol testing...',
    );
    for (const protocol of PROTOCOL_TRY_ORDER) {
      if (Number(protocol) === PROTOCOL.AUTO) continue;

      const protocolNumHex = protocol.toString(16).toUpperCase();
      const protocolName = PROTOCOL_DESCRIPTIONS[protocol] ?? `Protocol ${protocolNumHex}`;
      await log.debug(`[ProtocolManager] Trying protocol: ${protocolName} (${protocolNumHex})...`);

      try {
        // Try Protocol command (ATTP)
        const tryCmd = `${ELM_COMMANDS.TRY_PROTOCOL_PREFIX}${protocolNumHex}`;
        const tryResponse = await this.sendCommand(tryCmd, 10000);
        
        // More lenient response checking - with null check
        if (tryResponse) {
          const upper = tryResponse.toUpperCase();
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
            // Give protocol time to initialize
            await this.delay(DELAYS_MS.PROTOCOL_SWITCH);
            
            // Send test command to verify actual communication
            const testResponse = await this.sendProtocolTestCommand();
            if (testResponse && !isResponseError(testResponse)) {
              // Much more lenient test response validation
              const testUpper = testResponse.toUpperCase();
              if (!testUpper.includes('ERROR') && 
                  !testUpper.includes('UNABLE') &&
                  !testUpper.includes('?')) {
                
                await log.info(`[ProtocolManager] Protocol ${protocolName} appears to be working`);
                
                // Set it permanently
                const setCmd = `${ELM_COMMANDS.SET_PROTOCOL_PREFIX}${protocolNumHex}`;
                await this.sendCommand(setCmd, 2000);
                return { protocol, name: protocolName };
              }
            }
          }
        }

        // Close protocol before trying next
        try {
          await this.sendCommand(ELM_COMMANDS.PROTOCOL_CLOSE);
          await this.delay(DELAYS_MS.PROTOCOL_SWITCH);
        } catch {}

      } catch (error) {
        await log.error(`[ProtocolManager] Error testing ${protocolName}`, { error });
        try {
          await this.sendCommand(ELM_COMMANDS.PROTOCOL_CLOSE);
        } catch {}
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
      // Set Adaptive Timing (ATAT1 is generally safe, ATAT2 more aggressive for KWP)
      // Use ATAT1 as default from ElmProtocolInit basicInit
      const adaptTimingCmd =
        protocol === PROTOCOL.ISO_14230_4_KWP ||
        protocol === PROTOCOL.ISO_14230_4_KWP_FAST
          ? ELM_COMMANDS.ADAPTIVE_TIMING_2 // Use ATAT2 for KWP
          : ELM_COMMANDS.ADAPTIVE_TIMING_1; // Use ATAT1 for others
      await log.debug(
        `[ProtocolManager] Setting adaptive timing (${adaptTimingCmd})`,
      );
      await this.sendCommand(adaptTimingCmd, 1000);
      await this.delay(DELAYS_MS.COMMAND_SHORT);

      // Set Headers (ON for CAN, OFF otherwise generally)
      // Protocols 6 through 20 are CAN based
      const isCan =
        protocol >= PROTOCOL.ISO_15765_4_CAN_11BIT_500K &&
        protocol <= PROTOCOL.ISO_15765_4_CAN_29BIT_250K_8;
      if (isCan) {
        await log.debug(
          '[ProtocolManager] Ensuring headers are ON for CAN protocol (ATH1).',
        );
        await this.sendCommand(ELM_COMMANDS.HEADERS_ON, 1000);
      } else {
        await log.debug(
          '[ProtocolManager] Ensuring headers are OFF for non-CAN protocol (ATH0).',
        );
        await this.sendCommand(ELM_COMMANDS.HEADERS_OFF, 1000);
      }
      await this.delay(DELAYS_MS.COMMAND_SHORT);

      // Set Timeout (ATST) - Use a default moderate value, can be overridden later
      // Example: ATST64 (100ms in hex)
      // const timeoutHex = DELAYS_MS.TIMEOUT_NORMAL_MS.toString(16).toUpperCase().padStart(2, '0');
      // await this.sendCommand(`${ELM_COMMANDS.SET_TIMEOUT}${timeoutHex}`, 1000);
      // await this.delay(DELAYS_MS.COMMAND_SHORT);
      // Note: Timeout setting might be protocol specific, complex to generalize here. Let adapter manage with ATAT.

      // CAN Specific configurations (Flow Control, Formatting) - Add if needed
      if (isCan) {
        await log.debug(
          '[ProtocolManager] Ensuring CAN Auto-Formatting is ON (ATCAF1)',
        );
        await this.sendCommand(ELM_COMMANDS.CAN_AUTO_FORMAT_ON, 1000); // Enable CAN formatting
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        // Set default flow control? Done in BaseDTCRetriever configureForProtocol now.
      } else {
        // Ensure CAN Auto-Formatting is OFF for non-CAN
        await log.debug(
          '[ProtocolManager] Ensuring CAN Auto-Formatting is OFF (ATCAF0)',
        );
        await this.sendCommand(ELM_COMMANDS.CAN_AUTO_FORMAT_OFF, 1000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
      }

      await log.debug(
        `[ProtocolManager] Basic settings configured for protocol ${protocol}.`,
      );
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.warn(
        '[ProtocolManager] Error during protocol settings configuration:',
        { error: errorMsg },
      );
      // Continue even if some settings fail?
    }
  }
}
