import { log } from '../../utils/logger';
import { ELM_COMMANDS, RESPONSE_KEYWORDS, DELAYS_MS } from '../utils/constants';
import {
  cleanResponse,
  isResponseError,
  extractEcuAddresses,
  isResponseOk,
} from '../utils/helpers';

import type { SendCommandFunction } from '../utils/types';

/**
 * Raw DTC response structure containing both parsed and unparsed data
 * 
 * This interface encapsulates all DTC response data from the vehicle,
 * providing both raw response data and processed information.
 * 
 * @example
 * ```typescript
 * // Example of RawDTCResponse for a vehicle with two DTCs
 * const dtcResponse: RawDTCResponse = {
 *   rawString: "7E8 43 02 01 43 00 00 00 00\r7E9 43 00 00 00 00 00 00 00",
 *   rawResponse: [55, 69, 56, 32, 52, 51, 32, ...], // ASCII values
 *   response: [
 *     ["7E8", "43", "02", "01", "43", "00", "00", "00", "00"], 
 *     ["7E9", "43", "00", "00", "00", "00", "00", "00", "00"]
 *   ],
 *   rawBytesResponseFromSendCommand: [
 *     ["7E8", "43", "02", "01", "43", "00", "00", "00", "00"], 
 *     ["7E9", "43", "00", "00", "00", "00", "00", "00", "00"]
 *   ],
 *   isCan: true,
 *   protocolNumber: 6, // ISO 15765-4 CAN (11-bit, 500kbps)
 *   ecuAddress: "7E8" // Primary ECU address
 * };
 * ```
 */
export interface RawDTCResponse {
  /** Complete raw response string from the adapter */
  rawString: string | null;
  
  /** Raw response as array of ASCII byte values */
  rawResponse: number[] | null;
  
  /** Response parsed into frames and hex values */
  response: string[][] | null;
  
  /** Duplicate of response field for backward compatibility */
  rawBytesResponseFromSendCommand: string[][];
  
  /** Whether the current protocol is CAN-based */
  isCan: boolean;
  
  /** Current protocol number (from PROTOCOL enum) */
  protocolNumber: number;
  
  /** Primary ECU address that responded (e.g., "7E8") */
  ecuAddress: string | undefined;
}

/**
 * Base class for all DTC (Diagnostic Trouble Code) retrievers
 * 
 * This abstract base class implements common functionality for retrieving
 * diagnostic trouble codes from vehicle ECUs. It handles:
 * 
 * - Protocol detection and configuration
 * - Header management
 * - Error handling and recovery
 * - Response parsing and interpretation
 * - Multi-frame message handling
 * 
 * Specific DTC retriever implementations extend this class for different
 * service modes (Current DTCs, Pending DTCs, Permanent DTCs).
 * 
 * @example
 * ```typescript
 * // Direct usage of a derived class:
 * const retriever = new CurrentDTCRetriever(sendCommand);
 * const dtcResponse = await retriever.retrieveRawDTCs();
 * 
 * if (dtcResponse) {
 *   console.log(`Found ${dtcResponse.troubleCodes.length} DTCs`);
 *   dtcResponse.troubleCodes.forEach(dtc => console.log(dtc));
 * }
 * ```
 */
export class BaseDTCRetriever {
  // Protocol-related constants
  static PROTOCOL_TYPES = {
    CAN: 'CAN',
    KWP: 'KWP',
    ISO9141: 'ISO9141',
    J1850: 'J1850',
    UNKNOWN: 'UNKNOWN',
  };

  static HEADER_FORMATS = {
    CAN_11BIT: '11bit',
    CAN_29BIT: '29bit',
    KWP: 'kwp',
    ISO9141: 'iso9141',
    J1850: 'j1850',
    UNKNOWN: 'unknown',
  };

  static PROTOCOL_STATES = {
    INITIALIZED: 'INITIALIZED',
    CONFIGURING: 'CONFIGURING',
    READY: 'READY',
    ERROR: 'ERROR',
  };

  // Error patterns merged from OBDUtils.js and ElmProtocolInit.js
  static ERROR_RESPONSES = [
    RESPONSE_KEYWORDS.UNABLE_TO_CONNECT,
    RESPONSE_KEYWORDS.BUS_INIT, // Covers BUS INIT: ERROR
    RESPONSE_KEYWORDS.CAN_ERROR,
    RESPONSE_KEYWORDS.BUS_ERROR, // Covers BUS ERROR, BUSINIERR*
    RESPONSE_KEYWORDS.FB_ERROR,
    RESPONSE_KEYWORDS.DATA_ERROR, // Covers DATA ERROR, <DATA ERROR>
    RESPONSE_KEYWORDS.ERROR, // General ERROR
    RESPONSE_KEYWORDS.BUFFER_FULL,
    RESPONSE_KEYWORDS.BUS_BUSY,
    RESPONSE_KEYWORDS.NO_DATA, // Treat NO DATA as an error for general command validation
    RESPONSE_KEYWORDS.RX_ERROR, // Check if this is still needed?
    RESPONSE_KEYWORDS.STOPPED,
    'TIMEOUT', // Added TIMEOUT
    '7F', // Added 7F (Negative response)
    'UNABLE', // Part of UNABLE TO CONNECT
    'ACT ALERT', // From original JS
    'ERR', // From original JS
    '?', // ELM command error
  ].map(e => e.replace(/\s/g, '').toUpperCase()); // Pre-process for efficient matching

  // Header recognition patterns
  static CAN_11BIT_HEADER = /^7E[8-F]/i; // Use case-insensitive flag
  static CAN_29BIT_HEADER = /^18DAF1/i; // Use case-insensitive flag
  static KWP_HEADER = /^(48|68|81)/i; // Use case-insensitive flag, added 81 based on ISO/KWP formats
  static ISO9141_HEADER = /^(48|6B)/i; // Use case-insensitive flag
  static J1850_HEADER = /^(41|48|6B|A8|B8)/i; // Use case-insensitive flag

  static SERVICE_MODES = {
    MODE03: '03',
    MODE07: '07',
    MODE0A: '0A',
  };

  // Increased timeouts based on JS constants and testing
  protected static DATA_TIMEOUT = 10000; // For multi-frame reads
  protected static COMMAND_TIMEOUT = 5000; // Standard command timeout

  protected sendCommand: SendCommandFunction;
  protected mode: string;
  protected responsePrefix: string;

  // Protocol state
  protected isCan: boolean = false;
  protected protocolNumber: number = 0;
  protected protocolType: string = BaseDTCRetriever.PROTOCOL_TYPES.UNKNOWN;
  protected headerFormat: string = BaseDTCRetriever.HEADER_FORMATS.UNKNOWN;
  protected ecuAddress: string | null = null;
  protected protocolState: string =
    BaseDTCRetriever.PROTOCOL_STATES.INITIALIZED;

  // Communication state
  protected isHeaderEnabled: boolean = false;
  protected isEchoEnabled: boolean = false; // Assume echo off (ATE0)
  protected lineFeedsDisabled: boolean = false; // Assume linefeeds off (ATL0)
  protected spacesDisabled: boolean = false; // Assume spaces off (ATS0)

  /**
   * Creates a new DTC Retriever instance
   * 
   * Initializes the retriever with the necessary command function and OBD service mode.
   * It automatically calculates the expected response prefix based on the OBD protocol
   * specification (service mode + 0x40).
   * 
   * @param sendCommand - Function to send commands to the OBD adapter
   * @param mode - OBD service mode ('03' for current DTCs, '07' for pending DTCs, '0A' for permanent DTCs)
   * 
   * @example
   * ```typescript
   * // Create a retriever for current DTCs (Mode 03)
   * const currentDtcRetriever = new CurrentDTCRetriever(sendCommand);
   * 
   * // For more advanced usage with custom mode
   * const customRetriever = new BaseDTCRetriever(sendCommand, '03');
   * ```
   */
  constructor(sendCommand: SendCommandFunction, mode: string) {
    this.sendCommand = sendCommand;
    this.mode = mode;

    // Calculate response prefix (e.g., mode 03 -> response prefix 43)
    // This follows the OBD protocol specification where response prefixes
    // are service mode + 0x40
    this.responsePrefix = (parseInt(mode, 16) + 0x40)
      .toString(16)
      .toUpperCase();
  }

  /**
   * Creates a delay for timing control between commands
   * 
   * This helper method is used throughout the retrieval process to introduce
   * controlled delays between commands, allowing the ECU and adapter enough
   * time to process requests and prepare responses.
   * 
   * @param ms - Delay duration in milliseconds
   * @returns Promise that resolves after the specified delay
   */
  protected delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Configures the OBD adapter for optimal DTC retrieval
   * 
   * This method prepares the adapter for reliable DTC communication by:
   * 1. Resetting the adapter to ensure a clean state
   * 2. Configuring communication parameters (echo, linefeeds, spaces)
   * 3. Detecting the current protocol and its characteristics
   * 4. Setting optimal protocol-specific settings
   * 
   * The configuration process adapts to the specific protocol detected
   * (CAN, KWP, ISO9141, J1850) and applies the appropriate settings for
   * each protocol type.
   * 
   * Note: This method is automatically called by retrieveDTCs() and similar
   * methods before attempting to communicate with the vehicle.
   * 
   * @throws May throw an error if critical configuration steps fail
   * @returns Promise that resolves when configuration is complete
   */
  protected async configureAdapter(): Promise<void> {
    await log.info(
      `[${this.constructor.name}] Configuring adapter for DTC retrieval (Mode ${this.mode})`,
    );

    // Step 1: Reset the adapter for a clean state
    try {
      // Use direct sendCommand for adapter reset - not sending to vehicle
      await this.sendCommand(ELM_COMMANDS.RESET);
      await this.delay(DELAYS_MS.RESET); // Longer delay after reset
    } catch (error) {
      await log.warn(`[${this.constructor.name}] Reset warning:`, {
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue even if reset fails
    }

    // Step 2: Configure communication parameters
    const setupCommands = [
      // Basic settings for clean communication (from ElmProtocolInit.js / connectionService.ts)
      { cmd: ELM_COMMANDS.ECHO_OFF, desc: 'Disable echo' },
      { cmd: ELM_COMMANDS.LINEFEEDS_OFF, desc: 'Disable linefeeds' },
      { cmd: ELM_COMMANDS.SPACES_OFF, desc: 'Disable spaces' },
      // Enable headers initially for protocol detection and ECU address extraction
      { cmd: ELM_COMMANDS.HEADERS_ON, desc: 'Enable headers' },
      // Set adaptive timing (ATAT1 is safer, ATAT2 more aggressive) - Use ATAT1 default
      {
        cmd: ELM_COMMANDS.ADAPTIVE_TIMING_1,
        desc: 'Set adaptive timing mode 1',
      },
      // Set a reasonable default timeout (e.g., 100ms = 64 hex)
      // const defaultTimeoutHex = DELAYS_MS.TIMEOUT_NORMAL_MS.toString(16).toUpperCase().padStart(2,'0');
      // { cmd: `${ELM_COMMANDS.SET_TIMEOUT}${defaultTimeoutHex}`, desc: `Set timeout to ${DELAYS_MS.TIMEOUT_NORMAL_MS}ms` },
    ];

    for (const { cmd, desc } of setupCommands) {
      await log.debug(`[${this.constructor.name}] Setup: ${desc}`);
      try {
        // Use direct sendCommand for adapter configuration - moderate timeout
        const response = await this.sendCommand(cmd, 2000);

        // Track communication settings
        if (cmd === ELM_COMMANDS.ECHO_OFF) this.isEchoEnabled = false;
        else if (cmd === ELM_COMMANDS.LINEFEEDS_OFF)
          this.lineFeedsDisabled = true;
        else if (cmd === ELM_COMMANDS.SPACES_OFF) this.spacesDisabled = true;
        else if (cmd === ELM_COMMANDS.HEADERS_ON) this.isHeaderEnabled = true; // Mark headers as ON

        // Quick validation - allow '?' response for unsupported commands
        if (
          response &&
          !isResponseOk(response) &&
          !this.isErrorResponse(response) &&
          response.trim() !== '?'
        ) {
          await log.warn(
            `[${this.constructor.name}] Unexpected response for ${cmd}: ${response}`,
          );
        } else if (response?.trim() === '?') {
          await log.warn(
            `[${this.constructor.name}] Command "${cmd}" returned '?', possibly unsupported but continuing.`,
          );
        }
      } catch (error) {
        await log.error(
          `[${this.constructor.name}] Error during setup command ${cmd}:`,
          { error: error instanceof Error ? error.message : String(error) },
        );
        // Continue if one setup command fails? Or stop? Let's continue for now.
      }
      await this.delay(DELAYS_MS.COMMAND_SHORT); // Short delay between commands
    }

    // Step 3: Detect protocol
    this.protocolState = BaseDTCRetriever.PROTOCOL_STATES.CONFIGURING;
    await this.detectProtocol(); // This updates this.isCan, this.protocolNumber, etc.

    // Step 4: Protocol-specific configuration (like flow control for CAN)
    await this.configureForProtocol();

    // Step 5: After detection and specific configuration, potentially disable headers
    // if not needed for the current protocol's response parsing.
    if (!this.shouldKeepHeadersEnabled()) {
      try {
        await log.debug(
          `[${this.constructor.name}] Disabling headers for cleaner responses (ATH0)`,
        );
        await this.sendCommand(ELM_COMMANDS.HEADERS_OFF, 2000);
        this.isHeaderEnabled = false;
      } catch (error) {
        await log.warn(
          `[${this.constructor.name}] Failed to disable headers (ATH0)`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }

    // Step 6: Set protocol state to ready
    this.protocolState = BaseDTCRetriever.PROTOCOL_STATES.READY;

    await log.info(
      `[${this.constructor.name}] Adapter configuration complete. Protocol: ${this.protocolType} (${this.protocolNumber}), isCAN: ${this.isCan}, Headers: ${this.isHeaderEnabled}`,
    );
  }

  /**
   * Applies protocol-specific configurations (e.g., CAN Flow Control).
   * Logic based on ElmProtocolHelper.js and BaseDTCRetriever previous implementation.
   */
  protected async configureForProtocol(): Promise<void> {
    await log.debug(
      `[${this.constructor.name}] Applying config for protocol: ${this.protocolType}`,
    );

    if (this.isCan) {
      // CAN-specific configuration
      // Enable CAN Auto Formatting for easier parsing (usually default)
      try {
        await log.debug(
          `[${this.constructor.name}] Enabling CAN Auto Formatting (ATCAF1)`,
        );
        await this.sendCommand(ELM_COMMANDS.CAN_AUTO_FORMAT_ON, 2000);
      } catch (error) {
        await log.warn(
          `[${this.constructor.name}] Failed to enable CAN Auto Formatting`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
      await this.delay(DELAYS_MS.COMMAND_SHORT);

      // Set default Flow Control settings (can be optimized later)
      // These settings are common for many ECUs.
      const flowControlHeader =
        this.headerFormat === BaseDTCRetriever.HEADER_FORMATS.CAN_11BIT
          ? '7E0' // Default functional address for 11-bit request
          : '18DA10F1'; // Default physical address for 29-bit response from ECU F1
      const flowControlData = '300000'; // Block Size 0, Separation Time 0ms
      const flowControlMode = '1'; // Mode 1 (Auto Flow Control)

      await log.debug(
        `[${this.constructor.name}] Setting default CAN flow control: Header=${flowControlHeader}, Data=${flowControlData}, Mode=${flowControlMode}`,
      );
      try {
        // Use direct sendCommand for adapter configuration
        await this.sendCommand(`ATFCSH${flowControlHeader}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        await this.sendCommand(`ATFCSD${flowControlData}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        await this.sendCommand(`ATFCSM${flowControlMode}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
      } catch (error) {
        await log.warn(
          `[${this.constructor.name}] Default CAN flow control setup warning:`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    } else if (this.protocolType === BaseDTCRetriever.PROTOCOL_TYPES.KWP) {
      // KWP-specific configuration (Use ATAT2 for potentially faster KWP)
      try {
        await log.debug(
          `[${this.constructor.name}] Setting KWP timing (ATAT2)`,
        );
        await this.sendCommand(ELM_COMMANDS.ADAPTIVE_TIMING_2, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
      } catch (error) {
        await log.warn(
          `[${this.constructor.name}] KWP timing (ATAT2) warning:`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    } else {
      await log.debug(
        `[${this.constructor.name}] No specific configuration needed for protocol ${this.protocolType}`,
      );
    }
  }

  /**
   * Determine if headers should remain enabled for this protocol.
   * Headers are generally useful for CAN to distinguish responses from different ECUs.
   * For non-CAN, they can sometimes be disabled for cleaner data if only one ECU responds.
   */
  protected shouldKeepHeadersEnabled(): boolean {
    // Keep headers ON for CAN protocols to identify ECU responses.
    // Also keep ON if protocol is unknown, just in case.
    if (
      this.isCan ||
      this.protocolType === BaseDTCRetriever.PROTOCOL_TYPES.UNKNOWN
    ) {
      return true;
    }
    // Disable headers for non-CAN protocols for potentially cleaner responses,
    // assuming single ECU communication is typical.
    return false;
  }

  /**
   * Check if a response string indicates an ELM or OBD error.
   * Uses the static ERROR_RESPONSES list.
   */
  protected isErrorResponse(response: string | null): boolean {
    return isResponseError(response); // Use the helper function
  }

  /**
   * Extract ECU address (header) from a response line.
   * Relies on static header patterns and current protocol info.
   */
  protected extractEcuAddress(line: string): string | null {
    if (!line) return null;
    const trimmedLine = line.trim().toUpperCase();

    const addresses = extractEcuAddresses(trimmedLine);
    const firstAddress = addresses.length > 0 ? addresses[0] : null;

    return firstAddress !== undefined ? firstAddress : null;
  }

  /**
   * Creates a default empty RawDTCResponse object.
   */
  protected createEmptyResponse(): RawDTCResponse {
    return {
      rawString: null,
      rawResponse: null,
      response: null, // Use null for empty data
      rawBytesResponseFromSendCommand: [], // Use empty array for empty data
      isCan: this.isCan,
      protocolNumber: this.protocolNumber,
      ecuAddress: this.ecuAddress ?? undefined, // Use undefined if null
    };
  }

  /**
   * Retrieves raw Diagnostic Trouble Codes from the vehicle
   * 
   * This is the main entry point for DTC retrieval and handles the complete process:
   * 1. Configures the adapter with appropriate settings
   * 2. Sends the DTC retrieval command for the configured mode
   * 3. Processes and parses the response data
   * 4. Handles automatic retries on communication errors
   * 5. Provides protocol-specific optimizations
   * 
   * The method returns structured raw DTC data that can be further processed
   * by derived classes to extract the actual trouble codes.
   * 
   * @returns Promise resolving to a RawDTCResponse object containing the parsed data,
   *          or null if retrieval failed after all retry attempts
   * 
   * @example
   * ```typescript
   * // Using a derived class for current DTCs
   * const retriever = new CurrentDTCRetriever(sendCommand);
   * const rawResponse = await retriever.retrieveRawDTCs();
   * 
   * if (rawResponse) {
   *   console.log("Raw data retrieved successfully");
   *   console.log(`Response from ECU: ${rawResponse.ecuAddress}`);
   *   
   *   // The raw response can then be parsed into actual DTCs
   *   const dtcs = retriever.parseDTCs(rawResponse);
   * }
   * ```
   */
  async retrieveRawDTCs(): Promise<RawDTCResponse | null> {
    const maxRetries = 3;
    let retryCount = 0;

    await log.debug(
      `[${this.constructor.name}] Starting Mode ${this.mode} retrieval...`,
    );

    // Ensure adapter is configured before first attempt
    await this.configureAdapter();

    // Check if configuration resulted in an error state
    if (this.protocolState === BaseDTCRetriever.PROTOCOL_STATES.ERROR) {
      await log.error(
        `[${this.constructor.name}] Adapter configuration failed. Aborting DTC retrieval.`,
      );
      return null;
    }

    while (retryCount < maxRetries) {
      try {
        await log.debug(
          `[${this.constructor.name}] Attempt ${retryCount + 1}/${maxRetries}`,
        );

        // verifyAndGetResponse handles sending the command (this.mode) and processing
        const result = await this.verifyAndGetResponse();

        // Handle null result (e.g., timeout, critical error during send/receive)
        if (result === null) {
          await log.warn(
            `[${this.constructor.name}] No valid response or critical error during attempt ${retryCount + 1}.`,
          );
          retryCount++;
          if (retryCount < maxRetries) {
            await log.debug(
              `[${this.constructor.name}] Retrying after delay...`,
            );
            // Optional: Attempt reconfiguration or reset before retry?
            // await this.configureAdapter(); // Reconfigure before retry
            await this.delay(DELAYS_MS.RETRY); // Wait before retry
          }
          continue; // Go to next retry attempt
        }

        // Handle NO DATA response (valid response, but means no DTCs)
        // Check both rawString and the potentially cleaned response in result.response
        const hasNoData = result.rawString
          ?.toUpperCase()
          .includes(RESPONSE_KEYWORDS.NO_DATA);
        const isEmptyResponse =
          result.response === null ||
          result.response.length === 0 ||
          (result.response?.length === 1 && result.response[0]?.length === 0);

        if (hasNoData || isEmptyResponse) {
          await log.debug(
            `[${this.constructor.name}] NO DATA response or empty data received - interpreting as no DTCs present.`,
          );
          // Create an empty response object, but mark as successful retrieval
          return this.createEmptyResponse();
        }

        // If we got here, we have a valid response with data.
        // Try to extract ECU address if not already set during configuration/detection
        if (!this.ecuAddress && result.rawString) {
          const addresses = extractEcuAddresses(result.rawString);
          if (addresses.length > 0) {
            this.ecuAddress = addresses[0] ?? null; // Use the first detected address or null
            await log.info(
              `[${this.constructor.name}] Extracted ECU address from response: ${this.ecuAddress}`,
            );
          }
        }

        // Return the processed response
        return {
          rawString: result.rawString,
          rawResponse: result.rawResponse,
          response: result.response,
          // Ensure rawBytesResponseFromSendCommand matches the structure of `response`
          rawBytesResponseFromSendCommand: result.response ?? [],
          isCan: this.isCan,
          protocolNumber: this.protocolNumber,
          ecuAddress: this.ecuAddress ?? undefined,
        };
      } catch (error: unknown) {
        // Catch errors specifically from verifyAndGetResponse or subsequent processing
        await log.error(
          `[${this.constructor.name}] Error during retrieval attempt ${retryCount + 1}:`,
          {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        );
        retryCount++;

        if (retryCount < maxRetries) {
          await log.debug(`[${this.constructor.name}] Retrying after error...`);
          await this.delay(DELAYS_MS.RETRY); // Wait before retry
        }
      }
    } // End retry loop

    // All retries failed
    await log.error(
      `[${this.constructor.name}] Failed to retrieve DTCs for Mode ${this.mode} after ${maxRetries} attempts`,
    );
    this.protocolState = BaseDTCRetriever.PROTOCOL_STATES.ERROR; // Mark state as error
    return null; // Return null after all retries fail
  }

  /**
   * Processes CAN multi-frame responses by grouping frames by header.
   * Used within handleCANResponse.
   */
  protected processFramesByHeader(
    framesByHeader: Record<string, string[]>,
    line: string,
  ): void {
    // Match 11-bit (7Ex) or 29-bit (18DAxxxx) headers at the start of the line
    // Allow optional frame number like '0:' or '1:' before the header
    const headerMatch = line.match(
      /^(?:[0-9A-F]{1,2}:)?(7E[8-F]|18DA[0-9A-F]{4})/i,
    );
    if (headerMatch?.[1]) {
      const headerKey = headerMatch[1].toUpperCase();
      if (!framesByHeader[headerKey]) {
        framesByHeader[headerKey] = [];
      }
      // Extract content *after* the full match (including optional frame number and the header)
      const lineContent = line.substring(headerMatch[0].length).trim();
      if (lineContent) {
        // Only add if there's actual data after the header
        framesByHeader[headerKey].push(lineContent);
      }
    } else {
      // If no specific CAN header is found, add to 'unknown' for potential later processing
      // But only if the line isn't an ELM status message
      const cleanedLine = cleanResponse(line);
      if (
        cleanedLine &&
        !this.isErrorResponse(line) &&
        line !== '>' &&
        !line.includes('SEARCHING')
      ) {
        if (!framesByHeader['unknown']) {
          framesByHeader['unknown'] = [];
        }
        framesByHeader['unknown'].push(line.trim()); // Add the original trimmed line
      }
    }
  }

  /**
   * Handles CAN responses, including potential multi-frame ISO-TP messages.
   */
  protected async handleCANResponse(response: string): Promise<string[][]> {
    if (!response) return [];

    const lines = response.split(/[\r\n]+/).filter(line => line.trim() !== '');
    if (lines.length === 0) return [];

    // Check if this *looks* like a multi-frame response (multiple lines, potential ISO-TP indicators)
    const mightBeMultiFrame =
      lines.length > 1 &&
      lines.some(
        line =>
          /^\s*[0-9A-F]{1,2}:/.test(line) || /^[123]/.test(cleanResponse(line)),
      );

    if (this.isCan && mightBeMultiFrame) {
      // Use the more sophisticated multi-frame handling logic
      return await this.handleCANMultiFrame(lines);
    }

    // Otherwise, handle as simple frames (each line is a frame or part of one)
    // Process each line to extract hex bytes
    const processedFrames = lines.map(line =>
      this.extractBytesFromSingleFrame(line),
    );
    // Filter out any empty arrays resulting from processing status lines etc.
    return processedFrames.filter(frame => frame.length > 0);
  }

  /**
   * Parses raw OBD responses into structured data based on protocol type
   * 
   * This method acts as a protocol-aware parser that transforms unformatted
   * adapter responses into structured data that can be analyzed. It handles:
   * 
   * - CAN protocols: Uses specialized multi-frame handling for ISO-TP messages
   * - KWP protocols: Processes responses with KWP-specific header formats
   * - ISO9141/J1850: Handles the simpler response formats of these protocols
   * 
   * The output format is a two-dimensional array where:
   * - The outer array contains individual message frames
   * - Each inner array contains the hex byte values within that frame
   * 
   * This structured format allows higher-level methods to extract DTC values,
   * regardless of which protocol was used to retrieve them.
   * 
   * @param response - The raw string response from the adapter
   * @returns Promise resolving to a two-dimensional array of hex byte values
   * 
   * @example
   * // Example return value for a CAN response with two DTCs:
   * // [["43", "02", "01", "43", "00", "00", "00", "00"]]
   * // This represents Mode 43 (response to Mode 03), 2 DTCs,
   * // with DTC values 0143 (P0143) and 0000 (no second DTC)
   */
  protected async processRawResponse(response: string): Promise<string[][]> {
    if (!response) return [];

    // Use the appropriate handler based on protocol
    if (this.isCan) {
      return await this.handleCANResponse(response);
    } else if (this.protocolType === BaseDTCRetriever.PROTOCOL_TYPES.KWP) {
      return this.handleKWPResponse(response);
    } else {
      // Default handling for ISO9141, J1850, or UNKNOWN (treat as single frame mostly)
      const cleanedResponse = cleanResponse(response);
      // Assume non-CAN responses are single logical messages, possibly split by lines
      // Extract bytes from the entire cleaned response first
      const allBytes = this.extractBytesFromSingleFrame(cleanedResponse);
      // Only return if bytes were actually extracted
      return allBytes.length > 0 ? [allBytes] : [];
    }
  }

  /**
   * Extracts meaningful data bytes from a raw OBD response frame
   * 
   * This method performs the critical task of cleaning and parsing raw OBD
   * response data to extract only the relevant diagnostic bytes. It handles:
   * 
   * 1. Removing ELM frame numbering prefixes (e.g., "0:", "1:")
   * 2. Stripping the service mode response prefix (e.g., "43" for Mode 03)
   * 3. Removing protocol-specific headers based on protocol type
   * 4. Cleaning non-hex characters and formatting the data
   * 
   * The method is protocol-aware and handles different header formats:
   * - CAN 11-bit headers (e.g., "7E8")
   * - CAN 29-bit headers (e.g., "18DAF1")
   * - KWP headers (format/target/source bytes)
   * - ISO9141 headers (3-byte format)
   * - J1850 headers (various formats)
   * 
   * @param line - A single line/frame from the adapter response
   * @returns Array of hex byte strings (e.g., ["43", "01", "33", "00"])
   * 
   * @example
   * // For input: "7E8 43 01 33 00 00 00 00"
   * // Returns: ["43", "01", "33", "00", "00", "00", "00"]
   * 
   * // For input with headers disabled: "43 01 33 00 00 00 00" 
   * // Returns: ["01", "33", "00", "00", "00", "00"]
   */
  protected extractBytesFromSingleFrame(line: string): string[] {
    if (!line) return [];

    let dataPart = line.trim().toUpperCase();

    // 1. Remove ELM frame numbering if present (e.g., "0:", "1:")
    dataPart = dataPart.replace(/^\s*[0-9A-F]{1,2}:\s*/, '');

    // 2. Remove Mode response prefix (e.g., "43" for Mode 03)
    if (dataPart.startsWith(this.responsePrefix)) {
      dataPart = dataPart.substring(this.responsePrefix.length);
    }

    // 3. Remove protocol headers if they are enabled AND present
    if (this.isHeaderEnabled) {
      if (this.isCan) {
        if (
          this.headerFormat === BaseDTCRetriever.HEADER_FORMATS.CAN_11BIT &&
          BaseDTCRetriever.CAN_11BIT_HEADER.test(dataPart)
        ) {
          dataPart = dataPart.substring(3); // Remove 7Ex
        } else if (
          this.headerFormat === BaseDTCRetriever.HEADER_FORMATS.CAN_29BIT &&
          BaseDTCRetriever.CAN_29BIT_HEADER.test(dataPart)
        ) {
          dataPart = dataPart.substring(6); // Remove 18DAF1
        }
        // Handle 29bit physical addressing header more specifically if needed
        // else if (this.headerFormat === BaseDTCRetriever.HEADER_FORMATS.CAN_29BIT && /^18DA[0-9A-F]{4}/i.test(dataPart)) {
        //    dataPart = dataPart.substring(8); // Remove 18DAxxxx
        // }
      } else if (
        this.protocolType === BaseDTCRetriever.PROTOCOL_TYPES.KWP &&
        BaseDTCRetriever.KWP_HEADER.test(dataPart)
      ) {
        // KWP header format (e.g., 81 F1 11 43...) - Remove first 3 bytes (Format, Target, Source)
        if (dataPart.length >= 6) dataPart = dataPart.substring(6);
      } else if (
        this.protocolType === BaseDTCRetriever.PROTOCOL_TYPES.ISO9141 &&
        BaseDTCRetriever.ISO9141_HEADER.test(dataPart)
      ) {
        // ISO header format (e.g., 48 6B 11 43...) - Remove first 3 bytes
        if (dataPart.length >= 6) dataPart = dataPart.substring(6);
      } else if (
        this.protocolType === BaseDTCRetriever.PROTOCOL_TYPES.J1850 &&
        BaseDTCRetriever.J1850_HEADER.test(dataPart)
      ) {
        // J1850 header format (varies) - Try removing first 3 bytes as a guess
        if (dataPart.length >= 6) dataPart = dataPart.substring(6);
      }
    }

    // 4. Remove any remaining spaces and non-hex characters
    dataPart = dataPart.replace(/[^0-9A-F]/g, '');

    // 5. Split into pairs of characters (bytes)
    const bytes: string[] = [];
    for (let i = 0; i + 1 < dataPart.length; i += 2) {
      bytes.push(dataPart.substring(i, i + 2));
    }

    // Filter out potential "00" padding bytes often seen at the end?
    // This might be too aggressive, as "00" can be valid data.
    // Let's keep them for now and let the DTC parser handle "0000".
    // const filteredBytes = bytes.filter((byte, index, arr) => {
    //     // Keep byte if it's not "00" OR if it's not the last byte in a sequence of "00"s
    //     return byte !== '00' || (index + 1 < arr.length && arr[index + 1] !== '00');
    // });

    return bytes;
  }

  /**
   * Reassembles ISO-TP segmented CAN messages for complete data retrieval
   * 
   * CAN networks have a limited frame size (8 bytes), but diagnostic data
   * often exceeds this limit. The ISO-TP protocol (ISO 15765-2) allows
   * transmission of larger messages by segmenting them into multiple frames:
   * 
   * - First Frame (FF): Contains first segment and total message length
   * - Consecutive Frames (CF): Contains subsequent data segments
   * - Flow Control (FC): Manages transmission flow
   * 
   * This method handles the complex task of:
   * 1. Organizing frames by source ECU address
   * 2. Identifying frame types (SF, FF, CF, FC)
   * 3. Detecting and handling sequence errors
   * 4. Reassembling complete messages from segments
   * 5. Verifying message integrity
   * 
   * Without this reassembly, DTC data from modern vehicles would be incomplete
   * or completely unreadable, as most vehicles use multi-frame responses.
   * 
   * @param lines - Array of raw response lines from the adapter
   * @returns Promise resolving to an array of reassembled message frames
   */
  protected async handleCANMultiFrame(lines: string[]): Promise<string[][]> {
    await log.debug(
      `[${this.constructor.name}] Detected multi-frame CAN response with ${lines.length} lines. Processing...`,
    );

    // Group frames by header using the helper function
    const framesByHeader: { [header: string]: string[] } = {};
    for (const line of lines) {
      this.processFramesByHeader(framesByHeader, line);
    }

    const result: string[][] = [];

    // Process each group of frames associated with a header
    for (const [header, frames] of Object.entries(framesByHeader)) {
      await log.debug(
        `[${this.constructor.name}] Processing ${frames.length} frame(s) for header ${header}`,
      );

      if (header === 'unknown') {
        // For frames without a recognized CAN header, process each line individually
        for (const frame of frames) {
          const bytes = this.extractBytesFromSingleFrame(frame);
          if (bytes.length > 0) {
            result.push(bytes);
          }
        }
        continue; // Move to the next header group
      }

      // --- ISO-TP Reconstruction Logic ---
      let combinedData = '';
      let expectedFrameIndex = 1; // ISO-TP sequence number starts at 1 for CF
      let isMultiFrameSequenceActive = false;
      let totalLengthExpected = 0;

      for (const frame of frames) {
        // Clean the frame data part (remove potential spaces)
        const dataPart = frame.replace(/\s/g, '');
        if (!dataPart) continue;

        // Check for ISO-TP frame type indicator (first hex digit)
        const frameTypeNibble = dataPart.substring(0, 1);

        if (frameTypeNibble === '0') {
          // Single Frame (SF) - PCI: 0L LL...
          const length = parseInt(dataPart.substring(1, 2), 16);
          if (!isNaN(length) && length > 0 && length <= 7) {
            combinedData = dataPart.substring(2, 2 + length * 2); // Extract data bytes
            await log.debug(
              `[${this.constructor.name}] Header ${header}: Found Single Frame (SF), length=${length}, data=${combinedData}`,
            );
            // Single frame message is complete, break inner loop for this header
            break;
          } else {
            await log.warn(
              `[${this.constructor.name}] Header ${header}: Invalid Single Frame PCI: ${dataPart}`,
            );
            // Treat as unknown data? For now, skip.
          }
        } else if (frameTypeNibble === '1') {
          // First Frame (FF) - PCI: 1L LL LL...
          if (isMultiFrameSequenceActive) {
            await log.warn(
              `[${this.constructor.name}] Header ${header}: Received First Frame while already in a multi-frame sequence. Resetting sequence.`,
            );
          }
          const lengthHex = dataPart.substring(1, 4); // Get 12 bits for length
          totalLengthExpected = parseInt(lengthHex, 16);
          if (!isNaN(totalLengthExpected) && totalLengthExpected > 7) {
            combinedData = dataPart.substring(4); // Extract initial data bytes
            isMultiFrameSequenceActive = true;
            expectedFrameIndex = 1; // Expect Consecutive Frame with index 1 next
            await log.debug(
              `[${this.constructor.name}] Header ${header}: Found First Frame (FF), totalLength=${totalLengthExpected}, initialData=${combinedData}`,
            );
          } else {
            await log.warn(
              `[${this.constructor.name}] Header ${header}: Invalid First Frame PCI or length: ${dataPart}`,
            );
            // Reset sequence state
            isMultiFrameSequenceActive = false;
            combinedData = '';
          }
        } else if (frameTypeNibble === '2' && isMultiFrameSequenceActive) {
          // Consecutive Frame (CF) - PCI: 2N ...
          const sequenceNibble = dataPart.substring(1, 2);
          const sequenceNumber = parseInt(sequenceNibble, 16);
          if (!isNaN(sequenceNumber)) {
            if (sequenceNumber === expectedFrameIndex % 16) {
              // Check sequence number (0-F wrap around)
              combinedData += dataPart.substring(2); // Append data bytes
              expectedFrameIndex++;
              await log.debug(
                `[${this.constructor.name}] Header ${header}: Found Consecutive Frame (CF), sequence=${sequenceNumber}, appendedData=${dataPart.substring(2)}`,
              );
            } else {
              await log.warn(
                `[${this.constructor.name}] Header ${header}: Unexpected CF sequence. Expected ${expectedFrameIndex % 16}, got ${sequenceNumber}. Frame: ${dataPart}. Resetting sequence.`,
              );
              // Sequence error, discard this message for this header
              isMultiFrameSequenceActive = false;
              combinedData = '';
              break; // Stop processing frames for this header due to error
            }
          } else {
            await log.warn(
              `[${this.constructor.name}] Header ${header}: Invalid Consecutive Frame PCI: ${dataPart}`,
            );
          }
        } else if (frameTypeNibble === '3') {
          // Flow Control (FC) - PCI: 3S BS ST
          // Ignore flow control frames sent by the ECU (we only care about data)
          await log.debug(
            `[${this.constructor.name}] Header ${header}: Ignoring Flow Control Frame (FC): ${dataPart}`,
          );
        } else {
          // Not a recognized ISO-TP frame or not part of an active sequence
          await log.debug(
            `[${this.constructor.name}] Header ${header}: Treating as single/unknown frame data: ${frame}`,
          );
          // If we weren't in a sequence, treat this as a single frame's data
          if (!isMultiFrameSequenceActive) {
            combinedData = dataPart; // Replace any previous data for this header
            break; // Assume single frame complete
          }
          // If we *were* in a sequence, this might be an error or end of data? Ignore for now.
        }

        // Check if we have received the expected total length for multi-frame
        if (
          isMultiFrameSequenceActive &&
          combinedData.length >= totalLengthExpected * 2
        ) {
          await log.debug(
            `[${this.constructor.name}] Header ${header}: Multi-frame message complete. Expected ${totalLengthExpected} bytes, received ${combinedData.length / 2}.`,
          );
          // Trim excess data if any (shouldn't happen with correct length)
          combinedData = combinedData.substring(0, totalLengthExpected * 2);
          break; // Message complete for this header
        }
      } // End of loop through frames for one header

      // Convert the final combined data string (hex) into byte array
      if (combinedData) {
        const bytes: string[] = [];
        for (let i = 0; i + 1 < combinedData.length; i += 2) {
          bytes.push(combinedData.substring(i, i + 2));
        }
        if (bytes.length > 0) {
          result.push(bytes);
        }
      } else if (header !== 'unknown') {
        await log.warn(
          `[${this.constructor.name}] No valid data assembled for header ${header}.`,
        );
      }
    } // End of loop through headers

    return result;
  }

  /**
   * Enhanced method to send commands with timing appropriate for the detected protocol.
   */
  protected async sendCommandWithTiming(
    command: string,
    timeout?: number,
  ): Promise<string | null> {
    // Determine timeout based on protocol type and command
    let effectiveTimeout = timeout ?? BaseDTCRetriever.COMMAND_TIMEOUT; // Default timeout

    // Use longer timeouts for non-CAN protocols, especially for data retrieval commands
    if (!this.isCan) {
      effectiveTimeout = timeout ?? BaseDTCRetriever.DATA_TIMEOUT; // Longer default for non-CAN data reads
      await log.debug(
        `[${this.constructor.name}] Using longer timeout (${effectiveTimeout}ms) for non-CAN protocol.`,
      );
    } else {
      // For CAN, use standard command timeout unless data timeout is explicitly requested
      effectiveTimeout = timeout ?? BaseDTCRetriever.COMMAND_TIMEOUT;
    }

    await log.debug(
      `[${this.constructor.name}] Sending command "${command}" with timeout ${effectiveTimeout}ms`,
    );
    return await this.sendCommand(command, effectiveTimeout);
  }

  /**
   * Tries different CAN flow control configurations to optimize communication.
   * Based on ElmProtocolHelper.tryFlowControlConfigs.
   */
  protected async tryOptimizeFlowControl(canID?: string): Promise<boolean> {
    if (!this.isCan) {
      await log.debug(
        `[${this.constructor.name}] Skipping flow control optimization for non-CAN protocol.`,
      );
      return false; // Optimization only applies to CAN
    }

    // Determine the base flow control header to use
    let flowControlHeader = canID; // Use provided ID if available
    if (!flowControlHeader) {
      // Determine default based on protocol format
      flowControlHeader =
        this.headerFormat === BaseDTCRetriever.HEADER_FORMATS.CAN_11BIT
          ? '7E0' // ECU address that receives the request (tester is often F1)
          : '18DA10F1'; // Physical address for ECU F1 responding to tester 10
    }
    // Note: ATFCSH should be set to the *ECU's response header* (e.g., 7E8, 18DAF110)
    // Let's correct the logic - we need the ECU's expected response header.
    // This might require a successful 0100 response first to extract the ECU address.
    // Let's use the *typical* ECU response headers as defaults for now.
    const ecuResponseHeader =
      this.headerFormat === BaseDTCRetriever.HEADER_FORMATS.CAN_11BIT
        ? '7E8' // Typical ECU response header
        : '18DAF110'; // Typical ECU response header (Tester F1)

    await log.debug(
      `[${this.constructor.name}] Optimizing CAN flow control. Target ECU Response Header: ${ecuResponseHeader}`,
    );

    // Configurations to try (based on ElmProtocolHelper)
    const flowControlConfigs = [
      // Standard configuration
      {
        fcsh: ecuResponseHeader,
        fcsd: '300000',
        fcsm: '1',
        desc: 'Standard (BS=0, ST=0, Mode=1)',
      },
      // No wait mode
      {
        fcsh: ecuResponseHeader,
        fcsd: '300000',
        fcsm: '0',
        desc: 'No Wait (BS=0, ST=0, Mode=0)',
      },
      // Extended wait time (8ms)
      {
        fcsh: ecuResponseHeader,
        fcsd: '300008',
        fcsm: '1',
        desc: 'Extended Wait (BS=0, ST=8ms, Mode=1)',
      },
      // Different block size (e.g., 4 frames) - less common
      // { fcsh: ecuResponseHeader, fcsd: '300400', fcsm: '1', desc: 'Block Size 4 (BS=4, ST=0, Mode=1)' },
    ];

    for (const config of flowControlConfigs) {
      await log.debug(
        `[${this.constructor.name}] Trying Flow Control: ${config.desc}`,
      );
      try {
        // Set flow control parameters - use direct sendCommand (short timeout ok)
        await this.sendCommand(`ATFCSH${config.fcsh}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        await this.sendCommand(`ATFCSD${config.fcsd}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        await this.sendCommand(`ATFCSM${config.fcsm}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);

        // Test with the actual DTC command again - use timing
        const testResponse = await this.sendCommandWithTiming(this.mode);

        if (
          testResponse &&
          !this.isErrorResponse(testResponse) &&
          !testResponse.includes(RESPONSE_KEYWORDS.BUFFER_FULL)
        ) {
          await log.info(
            `[${this.constructor.name}] Flow control optimization successful with: ${config.desc}`,
          );
          return true; // Found working configuration
        } else {
          await log.debug(
            `[${this.constructor.name}] Flow control config (${config.desc}) did not yield valid response: ${testResponse ?? 'null'}`,
          );
        }
      } catch (error) {
        await log.warn(
          `[${this.constructor.name}] Flow control config failed (${config.desc}):`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
      await this.delay(DELAYS_MS.COMMAND_SHORT); // Wait before trying next config
    }

    await log.warn(
      `[${this.constructor.name}] Could not optimize flow control after trying all configurations.`,
    );
    return false; // None of the configurations worked reliably
  }

  /**
   * Sends the DTC request command and verifies/processes the response.
   * Handles potential flow control issues for CAN.
   * Based on logic flow from BaseDTCRetriever previous implementation and ElmProtocolHelper.
   */
  protected async verifyAndGetResponse(): Promise<{
    rawString: string | null;
    rawResponse: number[] | null; // Byte values of rawString
    response: string[][] | null; // Parsed hex byte arrays
  } | null> {
    try {
      // Ensure protocol state is ready before sending command
      if (this.protocolState !== BaseDTCRetriever.PROTOCOL_STATES.READY) {
        await log.warn(
          `[${this.constructor.name}] Protocol not ready (State: ${this.protocolState}). Aborting command ${this.mode}.`,
        );
        // Attempt reconfiguration? Or just fail? Let's fail for now.
        this.protocolState = BaseDTCRetriever.PROTOCOL_STATES.ERROR;
        return null;
      }

      // Send the command to retrieve DTCs for the specific mode
      const result = await this.sendCommandWithTiming(this.mode);

      // --- Response Validation ---
      if (result === null) {
        await log.warn(
          `[${this.constructor.name}] No response received for command ${this.mode}.`,
        );
        // Consider this an error state? Maybe transient timeout.
        // Let the retry loop in retrieveRawDTCs handle this. Return null for now.
        return null;
      }
      if (this.isErrorResponse(result)) {
        await log.warn(
          `[${this.constructor.name}] Error response received for command ${this.mode}: ${result}`,
        );
        // If specific errors occur, change state
        if (
          result.includes('UNABLE') ||
          result.includes('BUS ERROR') ||
          result.includes('TIMEOUT')
        ) {
          this.protocolState = BaseDTCRetriever.PROTOCOL_STATES.ERROR;
        }
        // Let the retry loop handle retrying. Return null for now.
        return null;
      }

      // --- Flow Control Check (CAN only) ---
      // Check for indicators of flow control issues specifically for CAN protocols
      const needsFlowControlCheck =
        this.isCan &&
        (result.includes(RESPONSE_KEYWORDS.BUFFER_FULL) ||
          result.includes(RESPONSE_KEYWORDS.FB_ERROR) ||
          // Very short responses might also indicate incomplete messages due to FC
          (result.length > 0 &&
            result.length < 10 &&
            !result.includes(RESPONSE_KEYWORDS.NO_DATA)));

      if (needsFlowControlCheck) {
        await log.debug(
          `[${this.constructor.name}] Detected potential CAN flow control issue or incomplete response. Response: ${result}. Attempting optimization...`,
        );

        // Try to optimize flow control based on current protocol/header info
        // Extract potential ECU address from this potentially problematic response
        const potentialEcuAddress = this.extractEcuAddress(result);
        const flowControlSuccess = await this.tryOptimizeFlowControl(
          potentialEcuAddress ?? undefined,
        );

        if (flowControlSuccess) {
          // Retry the command *once* after successful FC optimization
          await log.debug(
            `[${this.constructor.name}] Retrying command ${this.mode} after flow control optimization...`,
          );
          const retryResult = await this.sendCommandWithTiming(this.mode);

          if (retryResult && !this.isErrorResponse(retryResult)) {
            await log.info(
              `[${this.constructor.name}] Successfully received response after flow control optimization.`,
            );
            // Process the successful retry response
            const processedData = await this.processRawResponse(retryResult);
            const rawBytes = Array.from(retryResult).map(c => c.charCodeAt(0));
            return {
              rawString: retryResult,
              rawResponse: rawBytes,
              response: processedData,
            };
          } else {
            await log.warn(
              `[${this.constructor.name}] Command ${this.mode} still failed or gave error after flow control optimization. Response: ${retryResult ?? 'null'}`,
            );
            // Fall through to process the original problematic response
          }
        } else {
          await log.warn(
            `[${this.constructor.name}] Flow control optimization failed. Proceeding with original response.`,
          );
          // Fall through to process the original problematic response
        }
      }

      // --- Process Original Response ---
      // If no flow control issue detected, or if optimization failed, process the original response
      await log.debug(
        `[${this.constructor.name}] Processing response for command ${this.mode}: ${result}`,
      );
      const processedData = await this.processRawResponse(result);
      const rawBytes = Array.from(result).map(c => c.charCodeAt(0));

      return {
        rawString: result,
        rawResponse: rawBytes,
        response: processedData,
      };
    } catch (error) {
      // Catch errors during the sendCommandWithTiming or subsequent processing
      await log.error(
        `[${this.constructor.name}] Error during command execution or response processing for ${this.mode}:`,
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      );
      this.protocolState = BaseDTCRetriever.PROTOCOL_STATES.ERROR; // Set error state
      return null; // Return null to indicate failure at this stage
    }
  }

  /**
   * Handles responses specifically for KWP protocols.
   * KWP can return data in hex strings or sometimes raw byte arrays (if spaces are off).
   */
  protected handleKWPResponse(response: string): string[][] {
    if (!response) return [];

    const lines = response.split(/[\r\n]+/).filter(line => line.trim() !== '');
    const result: string[][] = [];

    for (const line of lines) {
      const processedLine = line.trim();

      // Check for raw byte format (comma-separated numbers) - unlikely with ATS0
      // if (/^[\d,\s]+$/.test(processedLine)) {
      //    // Handle comma-separated byte values if needed
      // }

      // Assume hex format, extract bytes
      const bytes = this.extractBytesFromSingleFrame(processedLine);
      if (bytes.length > 0) {
        result.push(bytes);
      }
    }

    // For KWP, multiple lines usually represent a single logical message.
    // Combine all extracted bytes into one frame? Or keep separate?
    // Let's keep them separate for now, similar to CAN, in case headers distinguish ECUs.
    return result.filter(frame => frame.length > 0);
  }

  /**
   * Resets the internal state of the retriever.
   */
  public resetState(): void {
    // Reset protocol state
    this.isCan = false;
    this.protocolNumber = 0;
    this.protocolType = BaseDTCRetriever.PROTOCOL_TYPES.UNKNOWN;
    this.headerFormat = BaseDTCRetriever.HEADER_FORMATS.UNKNOWN;
    this.ecuAddress = null;
    this.protocolState = BaseDTCRetriever.PROTOCOL_STATES.INITIALIZED;

    // Reset communication state tracking
    this.isHeaderEnabled = false; // Re-evaluated during configureAdapter
    this.isEchoEnabled = false; // Assumed off
    this.lineFeedsDisabled = false; // Assumed off
    this.spacesDisabled = false; // Assumed off

    void log.debug(`[${this.constructor.name}] State reset.`);
  }

  /**
   * Detects the active communication protocol by querying the adapter
   * 
   * This method determines which OBD protocol the adapter is currently using
   * by sending the ATDPN command (Describe Protocol by Number). Based on the
   * response, it updates internal state variables to optimize communication:
   * 
   * - isCan: Whether the protocol is CAN-based
   * - protocolNumber: The numeric ID of the protocol (from ELM327 specifications)
   * - protocolType: The protocol family (CAN, KWP, ISO9141, J1850)
   * - headerFormat: The specific header format used by the protocol
   * 
   * Different protocols require different handling of headers, timing, and
   * multi-frame messages. This method ensures subsequent operations use
   * the correct approach for the active protocol.
   * 
   * @returns Promise resolving to true if a valid protocol was detected, false otherwise
   */
  protected async detectProtocol(): Promise<boolean> {
    await log.debug(`[${this.constructor.name}] Detecting protocol (ATDPN)...`);
    try {
      // Get current protocol number - use direct sendCommand, short timeout
      const protocolResponse = await this.sendCommand(
        ELM_COMMANDS.GET_PROTOCOL_NUM,
        2000,
      );

      if (!protocolResponse || this.isErrorResponse(protocolResponse)) {
        await log.warn(
          `[${this.constructor.name}] Failed to get protocol number. Response: ${protocolResponse ?? 'null'}`,
        );
        this.updateProtocolInfo(-1); // Set to UNKNOWN
        return false;
      }

      // Clean the response
      const cleanedResponse = cleanResponse(protocolResponse);

      // Parse protocol number (expecting hex like 'A6' or '3')
      let protocolNum = -1;
      if (cleanedResponse && /^[A-F0-9]{1,2}$/i.test(cleanedResponse)) {
        protocolNum = parseInt(cleanedResponse, 16);
      } else {
        await log.warn(
          `[${this.constructor.name}] Unexpected format for protocol number response: ${cleanedResponse}`,
        );
      }

      // Update internal state based on the detected number
      this.updateProtocolInfo(protocolNum);

      await log.debug(
        `[${this.constructor.name}] Protocol detection complete. Number: ${this.protocolNumber}, Type: ${this.protocolType}, isCAN: ${this.isCan}, Header Format: ${this.headerFormat}`,
      );

      // Return true if a valid (non-UNKNOWN) protocol was identified
      return this.protocolType !== BaseDTCRetriever.PROTOCOL_TYPES.UNKNOWN;
    } catch (error) {
      await log.error(`[${this.constructor.name}] Error detecting protocol:`, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.updateProtocolInfo(-1); // Set to UNKNOWN on error
      return false;
    }
  }

  /**
   * Maps ELM protocol numbers to protocol types and characteristics
   * 
   * This method translates the numeric protocol ID (from ATDPN command)
   * into the corresponding protocol type, header format, and other 
   * protocol-specific characteristics. It handles:
   * 
   * - CAN protocols (6-20): Sets proper 11-bit or 29-bit header format
   * - ISO 9141-2 (3): Non-CAN protocol with specific timing requirements
   * - ISO 14230-4 KWP (4-5): Non-CAN protocol with header format needs
   * - SAE J1850 PWM/VPW (1-2): Older non-CAN protocol variants
   * 
   * This mapping ensures the retriever can properly format commands
   * and parse responses according to the protocol's requirements.
   * 
   * Protocol documentation reference:
   * - 0: Auto (protocol detection by adapter)
   * - 1: SAE J1850 PWM (41.6 kbaud, standard Ford)
   * - 2: SAE J1850 VPW (10.4 kbaud, standard GM)
   * - 3: ISO 9141-2 (5 baud init, 10.4 kbaud)
   * - 4: ISO 14230-4 KWP (5 baud init, 10.4 kbaud)
   * - 5: ISO 14230-4 KWP (fast init, 10.4 kbaud)
   * - 6: ISO 15765-4 CAN (11-bit ID, 500 kbaud)
   * - 7: ISO 15765-4 CAN (29-bit ID, 500 kbaud)
   * - 8: ISO 15765-4 CAN (11-bit ID, 250 kbaud)
   * - 9: ISO 15765-4 CAN (29-bit ID, 250 kbaud)
   * - 10+: Additional CAN variants
   * 
   * @param protocolNum - The protocol number from the adapter's ATDPN response
   */
  protected updateProtocolInfo(protocolNum: number): void {
    this.protocolNumber = protocolNum; // Store the raw number

    // Mapping based on ELM327 protocol numbers (from OBDUtils.js PROT enum and descriptions)
    // Protocol numbers 6-20 are CAN variants in OBDUtils definition
    if (protocolNum >= 6 && protocolNum <= 20) {
      this.protocolType = BaseDTCRetriever.PROTOCOL_TYPES.CAN;
      // Determine header format based on conventions (even=11bit, odd=29bit for 6-9, J1939 is 29bit)
      if (protocolNum === 10) {
        // SAE J1939 specific case
        this.headerFormat = BaseDTCRetriever.HEADER_FORMATS.CAN_29BIT;
      } else if (protocolNum >= 6 && protocolNum <= 9) {
        // Standard CAN: 6, 8 are 11-bit; 7, 9 are 29-bit
        this.headerFormat =
          protocolNum % 2 === 0
            ? BaseDTCRetriever.HEADER_FORMATS.CAN_11BIT
            : BaseDTCRetriever.HEADER_FORMATS.CAN_29BIT;
      } else {
        // Extended CAN protocols (11-20) - Assume standard applies (even=11, odd=29)
        // User1/2 CAN (B/C hex -> 11/12 dec) often 11-bit
        // ISO variants (D-F, 10-14 hex -> 13-20 dec) follow even/odd
        this.headerFormat =
          protocolNum % 2 === 0
            ? BaseDTCRetriever.HEADER_FORMATS.CAN_11BIT
            : BaseDTCRetriever.HEADER_FORMATS.CAN_29BIT;
      }
      this.isCan = true;
    } else if (protocolNum === 3) {
      // ISO 9141-2
      this.protocolType = BaseDTCRetriever.PROTOCOL_TYPES.ISO9141;
      this.headerFormat = BaseDTCRetriever.HEADER_FORMATS.ISO9141;
      this.isCan = false;
    } else if (protocolNum === 4 || protocolNum === 5) {
      // ISO 14230-4 KWP (5-baud or Fast init)
      this.protocolType = BaseDTCRetriever.PROTOCOL_TYPES.KWP;
      this.headerFormat = BaseDTCRetriever.HEADER_FORMATS.KWP;
      this.isCan = false;
    } else if (protocolNum === 1 || protocolNum === 2) {
      // SAE J1850 PWM or VPW
      this.protocolType = BaseDTCRetriever.PROTOCOL_TYPES.J1850;
      this.headerFormat = BaseDTCRetriever.HEADER_FORMATS.J1850;
      this.isCan = false;
    } else {
      // Protocol 0 (Auto) or invalid/unknown number
      this.protocolType = BaseDTCRetriever.PROTOCOL_TYPES.UNKNOWN;
      this.headerFormat = BaseDTCRetriever.HEADER_FORMATS.UNKNOWN;
      this.isCan = false; // Assume not CAN if unknown
      // Keep protocolNumber as 0 or the invalid number for reference
    }
  }
}
