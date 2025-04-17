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

  /**
   * Detects and sets the appropriate OBD protocol for vehicle communication
   *
   * This method implements a sophisticated protocol detection strategy:
   * 1. First attempts automatic protocol detection (ATSP0)
   * 2. If auto-detection fails, tries each protocol in priority order
   * 3. Verifies protocol viability with standard test commands
   *
   * The method handles all protocol negotiation details including:
   * - Protocol-specific timing requirements
   * - Verification of communication stability
   * - Recovery from protocol errors
   *
   * Based on ElmProtocolHelper.tryAllProtocols and related methods.
   *
   * @returns Promise resolving to the detected protocol information, or null if detection failed
   * @example
   * ```typescript
   * // Detect and set the appropriate protocol
   * const protocolInfo = await protocolManager.detectAndSetProtocol();
   *
   * if (protocolInfo) {
   *   console.log(`Detected protocol: ${protocolInfo.name} (${protocolInfo.protocol})`);
   *
   *   // Configure protocol-specific settings
   *   await protocolManager.configureProtocolSettings(protocolInfo.protocol);
   *
   *   // Continue with ECU communication
   * } else {
   *   console.error("Failed to detect compatible protocol");
   * }
   * ```
   */
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
      const autoSetResponse = await this.sendCommand(
        ELM_COMMANDS.AUTO_PROTOCOL,
        5000,
      ); // Timeout for ATSP0
      await this.delay(DELAYS_MS.COMMAND_MEDIUM);

      if (autoSetResponse && isResponseOk(autoSetResponse)) {
        // Verify connection with a standard command
        const verifyResponse = await this.sendCommand(
          PROTOCOL_TEST_COMMAND,
          5000,
        ); // Timeout for 0100
        await this.delay(DELAYS_MS.COMMAND_MEDIUM);

        // Check if response is valid and not NO DATA (NO DATA is acceptable here if protocol set)
        if (verifyResponse && !isResponseError(verifyResponse)) {
          // Auto detect *might* have succeeded, now find out which protocol was chosen
          const protocolNum = await this.getCurrentProtocolNumber();
          if (protocolNum !== null && protocolNum !== PROTOCOL.AUTO) {
            // Ensure it's not still 0
            const protocolName =
              PROTOCOL_DESCRIPTIONS[protocolNum] ?? `Protocol ${protocolNum}`;
            await log.info(
              `[ProtocolManager] Auto-detection successful. Protocol: ${protocolName} (${protocolNum})`,
            );
            // No need to set it again, ATSP0 already did.
            return { protocol: protocolNum, name: protocolName };
          } else {
            await log.warn(
              `[ProtocolManager] ATSP0 succeeded but failed to read back a specific protocol number or still reports AUTO. Response: ${verifyResponse}`,
            );
          }
        } else {
          await log.debug(
            `[ProtocolManager] ATSP0 verification failed or returned error/NO DATA. Response: ${verifyResponse ?? 'null'}`,
          );
        }
      } else {
        await log.debug(
          `[ProtocolManager] ATSP0 command failed or returned error. Response: ${autoSetResponse ?? 'null'}`,
        );
      }
      // Close protocol if auto failed, before trying manual
      try {
        await log.debug(
          '[ProtocolManager] Closing protocol after failed auto-attempt (ATPC)...',
        );
        await this.sendCommand(ELM_COMMANDS.PROTOCOL_CLOSE, 1000);
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
        await this.sendCommand(ELM_COMMANDS.PROTOCOL_CLOSE, 1000);
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
      // Skip AUTO protocol in manual check
      if (Number(protocol) === PROTOCOL.AUTO) continue;

      const protocolNumHex = protocol.toString(16).toUpperCase();
      const protocolName =
        PROTOCOL_DESCRIPTIONS[protocol] ?? `Protocol ${protocolNumHex}`;
      await log.debug(
        `[ProtocolManager] Trying protocol: ${protocolName} (${protocolNumHex})...`,
      );

      try {
        // Try Protocol command (ATTP) - checks if protocol is usable
        const tryCmd = `${ELM_COMMANDS.TRY_PROTOCOL_PREFIX}${protocolNumHex}`;
        const tryResponse = await this.sendCommand(tryCmd, 10000); // Long timeout for ATTP
        await this.delay(DELAYS_MS.COMMAND_MEDIUM); // Short delay after ATTP

        // Check if ATTP response is OK or Searching... (indicates protocol might work)
        // Allow empty response after ATTP as potentially successful initiation
        if (
          tryResponse &&
          (isResponseOk(tryResponse) ||
            cleanResponse(tryResponse).includes(RESPONSE_KEYWORDS.SEARCHING) ||
            tryResponse.trim() === '')
        ) {
          await log.debug(
            `[ProtocolManager] ATTP${protocolNumHex} response suggests potential compatibility: ${tryResponse}`,
          );

          // Send a standard command to confirm communication with ECU
          const testResponse = await this.sendCommand(
            PROTOCOL_TEST_COMMAND,
            5000,
          ); // Standard timeout for 0100
          await this.delay(DELAYS_MS.COMMAND_MEDIUM); // Short delay after test command

          // Check if the test command was successful (valid response, not error, not NO DATA)
          if (
            testResponse &&
            !isResponseError(testResponse) &&
            !cleanResponse(testResponse).includes(RESPONSE_KEYWORDS.NO_DATA)
          ) {
            // Protocol test succeeded! Now permanently set it using ATSP
            await log.info(
              `[ProtocolManager] Protocol ${protocolName} test successful! Setting permanently...`,
            );
            const setCommand = `${ELM_COMMANDS.SET_PROTOCOL_PREFIX}${protocolNumHex}`;
            const setResponse = await this.sendCommand(setCommand, 2000); // Timeout for ATSP
            await this.delay(DELAYS_MS.COMMAND_MEDIUM); // Short delay after ATSP

            if (setResponse && isResponseOk(setResponse)) {
              // Final check: Verify the protocol number was actually set
              const finalProtocolNum = await this.getCurrentProtocolNumber();
              if (finalProtocolNum === protocol) {
                await log.info(
                  `[ProtocolManager] Successfully set and verified protocol: ${protocolName} (${protocol})`,
                );
                return { protocol, name: protocolName };
              } else {
                await log.warn(
                  `[ProtocolManager] ATSP${protocolNumHex} reported OK, but ATDPN returned ${finalProtocolNum ?? 'null'}.`,
                );
                // Still consider it a success if ATSP said OK? Maybe. Let's return for now.
                return { protocol, name: protocolName };
              }
            } else {
              await log.warn(
                `[ProtocolManager] Failed to set protocol ${protocolName} with ATSP. Response: ${setResponse ?? 'null'}`,
              );
              // Consider test successful even if ATSP fails, if ATTP + 0100 worked? Risky.
              // Let's treat ATSP failure as protocol failure for robustness.
            }
          } else {
            await log.debug(
              `[ProtocolManager] Protocol ${protocolName} test (${PROTOCOL_TEST_COMMAND}) failed or returned NO DATA. Response: ${testResponse ?? 'null'}`,
            );
          }
        } else {
          await log.debug(
            `[ProtocolManager] Protocol ${protocolName} not supported by adapter or vehicle (ATTP failed). Response: ${tryResponse ?? 'null'}`,
          );
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await log.error(
          `[ProtocolManager] Error testing protocol ${protocolName}:`,
          { error: errorMsg },
        );
        // Ensure protocol is closed even if error occurred during test
      } finally {
        // Close the protocol before trying the next one
        try {
          await log.debug(
            `[ProtocolManager] Closing protocol ${protocolName} attempt (ATPC)...`,
          );
          await this.sendCommand(ELM_COMMANDS.PROTOCOL_CLOSE, 1000);
          await this.delay(DELAYS_MS.PROTOCOL_SWITCH); // Wait after closing
        } catch {
          /* Ignore cleanup error */
        }
      }
    } // End of protocol loop

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
