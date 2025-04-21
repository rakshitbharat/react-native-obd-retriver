import { log } from '../../utils/logger';
import {
  ELM_COMMANDS,
  DELAYS_MS,
  RESPONSE_KEYWORDS,
  STANDARD_PIDS,
  PROTOCOL,
  PROTOCOL_TEST_COMMAND,
} from '../utils/constants';
import {
  isResponseError,
  isResponseOk,
  extractProtocolNumber,
  extractEcuAddresses, // Needed for dynamic header extraction
  assembleMultiFrameResponse,
  parseVinFromResponse,
} from '../utils/helpers';

import type { ServiceMode } from './types'; // Keep ServiceMode type
import type { SendCommandFunction } from '../utils/types';

// Protocol/State constants needed internally, mirroring BaseDTCRetriever
const PROTOCOL_TYPES = {
  CAN: 'CAN',
  KWP: 'KWP',
  ISO9141: 'ISO9141',
  J1850: 'J1850',
  UNKNOWN: 'UNKNOWN',
} as const;
type ProtocolType = (typeof PROTOCOL_TYPES)[keyof typeof PROTOCOL_TYPES]; // Derive type

const HEADER_FORMATS = {
  CAN_11BIT: '11bit',
  CAN_29BIT: '29bit',
  KWP: 'kwp',
  ISO9141: 'iso9141',
  J1850: 'j1850',
  UNKNOWN: 'unknown',
} as const;
type HeaderFormat = (typeof HEADER_FORMATS)[keyof typeof HEADER_FORMATS]; // Derive type

const PROTOCOL_STATES = {
  INITIALIZED: 'INITIALIZED',
  CONFIGURING: 'CONFIGURING',
  READY: 'READY',
  ERROR: 'ERROR',
} as const;
type ProtocolState = (typeof PROTOCOL_STATES)[keyof typeof PROTOCOL_STATES]; // Derive type

/**
 * Retrieves the Vehicle Identification Number (VIN) from the vehicle
 *
 * The VINRetriever class specializes in retrieving the 17-character VIN
 * from vehicle ECUs using OBD Mode 09 PID 02. This class handles:
 *
 * - Adapter configuration for optimal VIN retrieval
 * - Protocol detection and adjustment
 * - Multi-frame response handling
 * - Flow control on CAN-based protocols
 * - Parsing and validation of VIN data
 * - Automatic retries with different settings
 *
 * The VIN is a crucial vehicle identifier containing encoded information about:
 * - Manufacturer/make (first 3 characters)
 * - Vehicle attributes (positions 4-8)
 * - Check digit validation (position 9)
 * - Model year (position 10)
 * - Plant code (position 11)
 * - Production sequence number (last 6 digits)
 *
 * This class is standalone and includes its own adapter configuration,
 * protocol detection, and enhanced flow control handling logic. It's designed
 * to work reliably across different vehicle makes, models, and OBD protocols.
 *
 * @example
 * ```typescript
 * // Create a VIN retriever instance
 * const vinRetriever = new VINRetriever(sendCommand);
 *
 * // Retrieve the vehicle's VIN
 * const vin = await vinRetriever.retrieveVIN();
 *
 * if (vin) {
 *   console.log(`Vehicle VIN: ${vin}`); // e.g. "1HGCM82633A123456"
 *   console.log(`Manufacturer: ${vin.substring(0,3)}`); // e.g. "1HG" (Honda)
 *   console.log(`Model Year: ${decodeModelYear(vin.charAt(9))}`); // e.g. "2003"
 * } else {
 *   console.error("Unable to retrieve VIN");
 * }
 * ```
 */
export class VINRetriever {
  // Service mode details for VIN retrieval
  static SERVICE_MODE: ServiceMode = {
    REQUEST: STANDARD_PIDS.VIN, // '0902'
    RESPONSE: 0x49,
    NAME: 'VEHICLE_VIN',
    DESCRIPTION: 'Vehicle Identification Number',
    troubleCodeType: 'INFO',
  };

  // Timeout constants
  private static readonly DATA_TIMEOUT = 10000;
  private static readonly COMMAND_TIMEOUT = 5000;

  // Injected dependencies
  private readonly sendCommand: SendCommandFunction;

  // Internal state
  private readonly mode: string = VINRetriever.SERVICE_MODE.REQUEST;
  private isCan: boolean = false;
  private protocolNumber: PROTOCOL | number = PROTOCOL.AUTO; // Default to AUTO (0)
  private protocolType: ProtocolType = PROTOCOL_TYPES.UNKNOWN;
  private headerFormat: HeaderFormat = HEADER_FORMATS.UNKNOWN;
  // Store the detected ECU response header for dynamic FC use
  private ecuResponseHeader: string | null = null;
  private protocolState: ProtocolState = PROTOCOL_STATES.INITIALIZED;
  private isHeaderEnabled: boolean = false; // Must be true for VIN retrieval

  constructor(sendCommand: SendCommandFunction) {
    this.sendCommand = sendCommand;
  }

  /**
   * Helper method to create a delay.
   */
  private delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Configure adapter specifically for VIN retrieval.
   * Includes reset, basic settings, protocol detection, ECU header detection, and specific config.
   */
  private async _configureAdapterForVIN(): Promise<boolean> {
    void log.info(
      // Use void for fire-and-forget log promises
      `[${this.constructor.name}] Configuring adapter for VIN retrieval...`,
    );
    this.protocolState = PROTOCOL_STATES.CONFIGURING;

    // Step 1: Reset the adapter
    try {
      await this.sendCommand(ELM_COMMANDS.RESET);
      await this.delay(DELAYS_MS.RESET);
    } catch (error) {
      void log.warn(`[${this.constructor.name}] Reset warning:`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Step 2: Basic communication parameters
    const setupCommands = [
      { cmd: ELM_COMMANDS.ECHO_OFF, desc: 'Disable echo' },
      { cmd: ELM_COMMANDS.LINEFEEDS_OFF, desc: 'Disable linefeeds' },
      { cmd: ELM_COMMANDS.SPACES_OFF, desc: 'Disable spaces' },
      // Headers ON is crucial for multi-frame VIN responses
      {
        cmd: ELM_COMMANDS.HEADERS_ON,
        desc: 'Enable headers (Required for VIN)',
      },
      {
        cmd: ELM_COMMANDS.ADAPTIVE_TIMING_1,
        desc: 'Set adaptive timing mode 1',
      },
    ];

    for (const { cmd, desc } of setupCommands) {
      void log.debug(`[${this.constructor.name}] Setup: ${desc}`);
      try {
        const response = await this.sendCommand(cmd, 2000);
        if (cmd === ELM_COMMANDS.HEADERS_ON) this.isHeaderEnabled = true;
        // Basic validation of setup command responses
        if (
          response &&
          !isResponseOk(response) &&
          !this.isErrorResponse(response) && // Check internal error status too
          response.trim() !== '?'
        ) {
          void log.warn(
            `[${this.constructor.name}] Unexpected response for ${cmd}: ${response}`,
          );
        } else if (response?.trim() === '?') {
          void log.warn(
            `[${this.constructor.name}] Command "${cmd}" returned '?', possibly unsupported.`,
          );
        }
      } catch (error) {
        void log.error(
          `[${this.constructor.name}] Error during setup command ${cmd}:`,
          { error: error instanceof Error ? error.message : String(error) },
        );
        // If essential command like Headers ON fails, abort configuration
        if (cmd === ELM_COMMANDS.HEADERS_ON) {
          this.protocolState = PROTOCOL_STATES.ERROR;
          return false;
        }
      }
      await this.delay(DELAYS_MS.COMMAND_SHORT);
    }

    // Step 3: Detect protocol
    const protocolDetected = await this._detectProtocol();
    if (!protocolDetected) {
      void log.error(`[${this.constructor.name}] Protocol detection failed.`);
      this.protocolState = PROTOCOL_STATES.ERROR;
      return false;
    }

    // Step 3.5: (NEW) Detect actual ECU response header if using CAN
    if (this.isCan) {
      await this._detectEcuResponseHeader(); // Attempt to find the real header
    }

    // Step 4: Protocol-specific configuration (including default Flow Control for CAN)
    await this._configureForProtocol(); // Uses detected header if available

    // Step 5: Set protocol state to ready
    this.protocolState = PROTOCOL_STATES.READY;
    void log.info(
      `[${this.constructor.name}] Adapter configuration complete. Protocol: ${this.protocolType} (${this.protocolNumber}), isCAN: ${this.isCan}, Headers: ${this.isHeaderEnabled}`,
      this.ecuResponseHeader ? { ecuHeader: this.ecuResponseHeader } : {},
    );
    return true;
  }

  /**
   * (NEW) Attempts to detect the primary ECU response header by sending 0100.
   * Stores the result in this.ecuResponseHeader.
   */
  private async _detectEcuResponseHeader(): Promise<void> {
    if (!this.isCan) return; // Only relevant for CAN

    void log.debug(
      `[${this.constructor.name}] Attempting to detect ECU response header (0100)...`,
    );
    try {
      const response = await this._sendCommandWithTiming(
        STANDARD_PIDS.SUPPORTED_PIDS_1,
        5000,
      ); // Use 0100
      if (response && !this.isErrorResponse(response)) {
        const addresses = extractEcuAddresses(response);
        if (addresses.length > 0 && addresses[0] !== undefined) {
          this.ecuResponseHeader = addresses[0]; // Now safely assignable to string | null
          void log.info(
            `[${this.constructor.name}] Detected ECU response header: ${this.ecuResponseHeader}`,
          );
        } else {
          void log.warn(
            `[${this.constructor.name}] Command 0100 successful, but no valid ECU header extracted from response: ${response}`,
          );
        }
      } else {
        void log.warn(
          `[${this.constructor.name}] Failed to get valid response for 0100 header detection: ${response ?? 'null'}`,
        );
      }
    } catch (error) {
      void log.error(
        `[${this.constructor.name}] Error during ECU header detection (0100):`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * Determine the active protocol by querying the adapter (ATDPN).
   * Updates internal state variables.
   */
  private async _detectProtocol(): Promise<boolean> {
    void log.debug(`[${this.constructor.name}] Detecting protocol (ATDPN)...`);
    try {
      const response = await this.sendCommand(
        ELM_COMMANDS.GET_PROTOCOL_NUM,
        2000,
      );
      const protocolNum = extractProtocolNumber(response);

      // Check internal error status for the response
      if (protocolNum === null || this.isErrorResponse(response)) {
        void log.warn(
          `[${this.constructor.name}] Failed to get protocol number. Response: ${response ?? 'null'}`,
        );
        this._updateProtocolInfo(-1); // Set to UNKNOWN
        return false;
      }

      this._updateProtocolInfo(protocolNum);
      void log.debug(
        `[${this.constructor.name}] Protocol detection complete. Number: ${this.protocolNumber}, Type: ${this.protocolType}, isCAN: ${this.isCan}, Header Format: ${this.headerFormat}`,
      );
      return this.protocolType !== PROTOCOL_TYPES.UNKNOWN;
    } catch (error) {
      void log.error(`[${this.constructor.name}] Error detecting protocol:`, {
        error: error instanceof Error ? error.message : String(error),
      });
      this._updateProtocolInfo(-1); // Set to UNKNOWN on error
      return false;
    }
  }

  /**
   * Updates internal protocol state based on the ELM protocol number.
   */
  private _updateProtocolInfo(protocolNum: number): void {
    this.protocolNumber = protocolNum; // Store the raw number

    // Mapping based on ELM327 protocol numbers
    if (protocolNum >= 6 && protocolNum <= 20) {
      this.protocolType = PROTOCOL_TYPES.CAN;
      this.isCan = true;
      // Determine header format based on conventions
      if (protocolNum === PROTOCOL.SAE_J1939_CAN_29BIT_250K) {
        this.headerFormat = HEADER_FORMATS.CAN_29BIT;
      } else if (
        protocolNum >= PROTOCOL.ISO_15765_4_CAN_11BIT_500K &&
        protocolNum <= PROTOCOL.ISO_15765_4_CAN_29BIT_250K_8 // Updated upper bound
      ) {
        // Standard CAN and Extended variants: 6, 8, 11, 13, 15, 17, 19 are 11-bit; 7, 9, 10, 12, 14, 16, 18, 20 are 29-bit
        // Simple check often works: even number for 11-bit, odd for 29-bit within known ranges
        // Be explicit for known exceptions if any exist
        this.headerFormat =
          protocolNum % 2 === 0
            ? HEADER_FORMATS.CAN_11BIT
            : HEADER_FORMATS.CAN_29BIT;
      } else {
        // Fallback pattern for potentially unknown CAN protocols
        this.headerFormat =
          protocolNum % 2 === 0
            ? HEADER_FORMATS.CAN_11BIT
            : HEADER_FORMATS.CAN_29BIT;
      }
    } else if (protocolNum === PROTOCOL.ISO_9141_2) {
      this.protocolType = PROTOCOL_TYPES.ISO9141;
      this.headerFormat = HEADER_FORMATS.ISO9141;
      this.isCan = false;
    } else if (
      protocolNum === PROTOCOL.ISO_14230_4_KWP ||
      protocolNum === PROTOCOL.ISO_14230_4_KWP_FAST
    ) {
      this.protocolType = PROTOCOL_TYPES.KWP;
      this.headerFormat = HEADER_FORMATS.KWP;
      this.isCan = false;
    } else if (
      protocolNum === PROTOCOL.SAE_J1850_PWM ||
      protocolNum === PROTOCOL.SAE_J1850_VPW
    ) {
      this.protocolType = PROTOCOL_TYPES.J1850;
      this.headerFormat = HEADER_FORMATS.J1850;
      this.isCan = false;
    } else {
      this.protocolType = PROTOCOL_TYPES.UNKNOWN;
      this.headerFormat = HEADER_FORMATS.UNKNOWN;
      this.isCan = false;
      // Ensure protocolNumber reflects unknown status if applicable (e.g., if -1 was passed)
      if (protocolNum < 0) this.protocolNumber = PROTOCOL.AUTO; // Or represent invalid state appropriately
    }
  }

  /**
   * Applies protocol-specific configurations, including default CAN Flow Control using detected header if available.
   */
  private async _configureForProtocol(): Promise<void> {
    void log.debug(
      `[${this.constructor.name}] Applying config for protocol: ${this.protocolType}`,
    );

    if (this.isCan) {
      // Enable CAN Auto Formatting
      try {
        void log.debug(
          `[${this.constructor.name}] Enabling CAN Auto Formatting (ATCAF1)`,
        );
        await this.sendCommand(ELM_COMMANDS.CAN_AUTO_FORMAT_ON, 2000);
      } catch (error) {
        void log.warn(
          `[${this.constructor.name}] Failed to enable CAN Auto Formatting`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
      await this.delay(DELAYS_MS.COMMAND_SHORT);

      // Set default Flow Control settings
      // Use the detected ECU response header if available, otherwise fallback to typical defaults
      const fcHeaderToSet =
        this.ecuResponseHeader ?? // Use detected header first
        (this.headerFormat === HEADER_FORMATS.CAN_11BIT ? '7E8' : '18DAF110'); // Fallback

      const flowControlData = '300000'; // BS=0, ST=0ms
      const flowControlMode = '1'; // Auto FC

      void log.debug(
        `[${this.constructor.name}] Setting default CAN flow control: Header=${fcHeaderToSet}, Data=${flowControlData}, Mode=${flowControlMode}`,
      );
      try {
        // Set the Flow Control Header (ATFCSH) using the determined header
        await this.sendCommand(`ATFCSH${fcHeaderToSet}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        await this.sendCommand(`ATFCSD${flowControlData}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        await this.sendCommand(`ATFCSM${flowControlMode}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
      } catch (error) {
        void log.warn(
          `[${this.constructor.name}] Default CAN flow control setup warning:`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    } else if (this.protocolType === PROTOCOL_TYPES.KWP) {
      // KWP-specific: Use ATAT2 for potentially faster KWP
      try {
        void log.debug(`[${this.constructor.name}] Setting KWP timing (ATAT2)`);
        await this.sendCommand(ELM_COMMANDS.ADAPTIVE_TIMING_2, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
      } catch (error) {
        void log.warn(
          `[${this.constructor.name}] KWP timing (ATAT2) warning:`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }
    // No specific config needed for ISO9141/J1850 here
  }

  /**
   * Enhanced method to send commands with timing appropriate for the detected protocol.
   */
  private async _sendCommandWithTiming(
    command: string,
    timeout?: number,
  ): Promise<string | null> {
    let effectiveTimeout = timeout ?? VINRetriever.COMMAND_TIMEOUT; // Default
    // Use longer timeout for non-CAN protocols when sending data request commands
    if (!this.isCan && command === this.mode) {
      effectiveTimeout = timeout ?? VINRetriever.DATA_TIMEOUT;
      void log.debug(
        `[${this.constructor.name}] Using longer timeout (${effectiveTimeout}ms) for non-CAN VIN request.`,
      );
    }

    void log.debug(
      `[${this.constructor.name}] Sending command "${command}" with timeout ${effectiveTimeout}ms`,
    );
    // The injected sendCommand handles the actual sending and timeout logic
    return await this.sendCommand(command, effectiveTimeout);
  }

  /**
   * Check if a response string indicates an ELM or OBD error.
   * Uses imported isResponseError helper, treats null response as error.
   */
  private isErrorResponse(response: string | null): boolean {
    return response === null || isResponseError(response);
  }

  /**
   * Tries different CAN flow control configurations to optimize communication.
   * Now includes Block Size testing and uses detected ECU header.
   */
  private async _tryOptimizeFlowControl(): Promise<boolean> {
    if (!this.isCan) {
      return false;
    }

    const baseEcuResponseHeader =
      this.ecuResponseHeader ??
      (this.headerFormat === HEADER_FORMATS.CAN_11BIT ? '7E8' : '18DAF110');

    void log.debug(
      `[${this.constructor.name}] Optimizing CAN flow control. Target ECU Response Header: ${baseEcuResponseHeader}`,
    );

    // Enhanced configurations with more variations
    const baseConfigs = [
      // Standard configurations
      {
        fcsh: baseEcuResponseHeader,
        fcsd: '300000',
        fcsm: '1',
        desc: `Std ${baseEcuResponseHeader} (BS=0, ST=0, Mode=1)`,
      },
      // No wait mode
      {
        fcsh: baseEcuResponseHeader,
        fcsd: '300000',
        fcsm: '0',
        desc: `Std ${baseEcuResponseHeader} (BS=0, ST=0, Mode=0)`,
      },
      // Extended wait times
      {
        fcsh: baseEcuResponseHeader,
        fcsd: '300008',
        fcsm: '1',
        desc: `Std ${baseEcuResponseHeader} (BS=0, ST=8ms, Mode=1)`,
      },
      {
        fcsh: baseEcuResponseHeader,
        fcsd: '300010',
        fcsm: '1',
        desc: `Std ${baseEcuResponseHeader} (BS=0, ST=16ms, Mode=1)`,
      },
      // Block size variations
      {
        fcsh: baseEcuResponseHeader,
        fcsd: '300200',
        fcsm: '1',
        desc: `Std ${baseEcuResponseHeader} (BS=2, ST=0, Mode=1)`,
      },
      {
        fcsh: baseEcuResponseHeader,
        fcsd: '300400',
        fcsm: '1',
        desc: `Std ${baseEcuResponseHeader} (BS=4, ST=0, Mode=1)`,
      },
      {
        fcsh: baseEcuResponseHeader,
        fcsd: '300800',
        fcsm: '1',
        desc: `Std ${baseEcuResponseHeader} (BS=8, ST=0, Mode=1)`,
      },
      // Combined BS and ST variations
      {
        fcsh: baseEcuResponseHeader,
        fcsd: '300204',
        fcsm: '1',
        desc: `Std ${baseEcuResponseHeader} (BS=2, ST=4ms, Mode=1)`,
      },
      {
        fcsh: baseEcuResponseHeader,
        fcsd: '300408',
        fcsm: '1',
        desc: `Std ${baseEcuResponseHeader} (BS=4, ST=8ms, Mode=1)`,
      },
      {
        fcsh: baseEcuResponseHeader,
        fcsd: '300810',
        fcsm: '1',
        desc: `Std ${baseEcuResponseHeader} (BS=8, ST=16ms, Mode=1)`,
      },
    ];

    // For 29-bit CAN, try common alternate headers with progressive timing
    if (this.headerFormat === HEADER_FORMATS.CAN_29BIT) {
      const alternateHeaders = ['18DAF110', '18DAF120', '18DAF130'].filter(
        h => h !== baseEcuResponseHeader,
      );
      const separationTimes = ['00', '04', '08', '10']; // 0ms, 4ms, 8ms, 16ms
      const blockSizes = ['00', '02', '04', '08']; // BS=0,2,4,8

      for (const header of alternateHeaders) {
        for (const st of separationTimes) {
          for (const bs of blockSizes) {
            // Only add selective combinations to avoid too many attempts
            if (
              (st === '00' && bs === '00') || // Basic
              (st === '08' && bs === '04') || // Medium
              (st === '10' && bs === '08') // Aggressive
            ) {
              baseConfigs.push({
                fcsh: header,
                fcsd: `30${bs}${st}`,
                fcsm: '1',
                desc: `Alt ${header} (BS=${parseInt(bs, 16)}, ST=${parseInt(st, 16)}ms, Mode=1)`,
              });
            }
          }
        }
      }
    }

    // Enhanced response validation
    const validateResponse = (response: string | null): boolean => {
      if (!response || this.isErrorResponse(response)) return false;

      // Check for common error patterns
      if (
        response.includes(RESPONSE_KEYWORDS.BUFFER_FULL) ||
        response.includes(RESPONSE_KEYWORDS.FB_ERROR) ||
        response.includes(RESPONSE_KEYWORDS.CAN_ERROR)
      ) {
        return false;
      }

      // VIN response should be substantial and contain valid data patterns
      const cleanResponse = response.replace(/\s/g, '').toUpperCase();

      // Check for minimum length (typical VIN response is quite long)
      if (cleanResponse.length < 20) return false;

      // Check for expected Mode 09 response pattern
      if (!cleanResponse.includes('49')) return false;

      // Verify we have enough data bytes for a VIN
      const dataBytes = cleanResponse.match(/[0-9A-F]{2}/g) || [];
      if (dataBytes.length < 20) return false; // VIN needs at least 17 bytes plus overhead

      return true;
    };

    // Rest of the flow control testing logic
    for (const config of baseConfigs) {
      void log.debug(
        `[${this.constructor.name}] Trying Flow Control: ${config.desc}`,
      );
      try {
        // Set flow control parameters
        await this.sendCommand(`ATFCSH${config.fcsh}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        await this.sendCommand(`ATFCSD${config.fcsd}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
        await this.sendCommand(`ATFCSM${config.fcsm}`, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);

        // Test configuration with VIN request
        const testResponse = await this._sendCommandWithTiming(
          this.mode,
          VINRetriever.DATA_TIMEOUT,
        );

        if (validateResponse(testResponse)) {
          void log.info(
            `[${this.constructor.name}] Flow control optimization successful with: ${config.desc}`,
          );
          this.ecuResponseHeader = config.fcsh;
          return true;
        }

        void log.debug(
          `[${this.constructor.name}] Config ${config.desc} failed validation`,
        );
      } catch (error) {
        void log.warn(
          `[${this.constructor.name}] Flow control config failed (${config.desc}):`,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
      await this.delay(DELAYS_MS.COMMAND_SHORT);
    }

    return false;
  }

  /**
   * Sends the VIN request command and verifies/processes the response.
   * Handles potential flow control issues for CAN. Returns raw response string on success.
   */
  private async _sendVINRequestAndProcess(): Promise<string | null> {
    try {
      if (this.protocolState !== PROTOCOL_STATES.READY) {
        void log.warn(
          `[${this.constructor.name}] Protocol not ready (State: ${this.protocolState}). Aborting command ${this.mode}.`,
        );
        this.protocolState = PROTOCOL_STATES.ERROR;
        return null;
      }

      // Send the command using timed sender, use DATA_TIMEOUT as VIN can be multi-frame
      const result = await this._sendCommandWithTiming(
        this.mode,
        VINRetriever.DATA_TIMEOUT,
      );

      // Check for initial errors or null response
      if (result === null || this.isErrorResponse(result)) {
        void log.warn(
          `[${this.constructor.name}] Error or no response for command ${this.mode}: ${result ?? 'null'}`,
        );
        // Update state if critical error detected
        if (
          result !== null &&
          (result.includes('UNABLE') ||
            result.includes('BUS ERROR') ||
            result.includes('TIMEOUT'))
        ) {
          this.protocolState = PROTOCOL_STATES.ERROR;
        }
        return null; // Return null to indicate failure for this attempt
      }

      // --- Flow Control Check (CAN only) ---
      // Heuristic check for potential flow control issues
      const needsFlowControlCheck =
        this.isCan &&
        (result.includes(RESPONSE_KEYWORDS.BUFFER_FULL) ||
          result.includes(RESPONSE_KEYWORDS.FB_ERROR) ||
          // Check for suspiciously short responses that aren't NO DATA
          (result.length > 0 &&
            result.length < 20 && // Arbitrary short length
            !result.includes(RESPONSE_KEYWORDS.NO_DATA)));

      if (needsFlowControlCheck) {
        void log.debug(
          `[${this.constructor.name}] Detected potential CAN flow control issue. Response: ${result}. Attempting optimization...`,
        );
        const flowControlSuccess = await this._tryOptimizeFlowControl();

        if (flowControlSuccess) {
          // Retry the command *once* after successful FC optimization
          void log.debug(
            `[${this.constructor.name}] Retrying command ${this.mode} after flow control optimization...`,
          );
          const retryResult = await this._sendCommandWithTiming(
            this.mode,
            VINRetriever.DATA_TIMEOUT,
          );

          if (retryResult && !this.isErrorResponse(retryResult)) {
            void log.info(
              `[${this.constructor.name}] Successfully received response after flow control optimization.`,
            );
            // Return the successful retry response for processing
            return retryResult;
          } else {
            void log.warn(
              `[${this.constructor.name}] Command ${this.mode} still failed or gave error after flow control optimization. Response: ${retryResult ?? 'null'}. Processing original response.`,
            );
            // Fall through to process the original problematic response (result)
          }
        } else {
          void log.warn(
            `[${this.constructor.name}] Flow control optimization failed. Proceeding with original response.`,
          );
          // Fall through to process the original problematic response (result)
        }
      }

      // --- Process Original or Successful Retry Response ---
      void log.debug(
        `[${this.constructor.name}] Processing final response for command ${this.mode}: ${result}`,
      );
      // Return the raw string for assembly and parsing
      return result;
    } catch (error) {
      void log.error(
        `[${this.constructor.name}] Error during command execution or response processing for ${this.mode}:`,
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      );
      this.protocolState = PROTOCOL_STATES.ERROR; // Set error state
      return null; // Return null to indicate failure at this stage
    }
  }

  /**
   * Retrieves and parses the VIN.
   * Orchestrates configuration, command sending, retries, and parsing.
   */
  public async retrieveVIN(): Promise<string | null> {
    // Add connection validation at start
    if (!this.sendCommand) {
      void log.error(
        `[${this.constructor.name}] No valid command sender available`,
      );
      return null;
    }

    // Continue with existing retrieval logic
    void log.debug(`[${this.constructor.name}] Attempting to retrieve VIN...`);
    let attempt = 0;
    const maxAttempts = 3; // Allow retries for the whole process

    while (attempt < maxAttempts) {
      attempt++;
      void log.debug(
        `[${this.constructor.name}] VIN Retrieval Attempt ${attempt}/${maxAttempts}`,
      );

      try {
        // Reset state before each attempt for clean configuration
        this.resetState();

        // Configure adapter specifically for VIN retrieval
        const configSuccess = await this._configureAdapterForVIN();
        if (!configSuccess) {
          void log.error(
            `[${this.constructor.name}] Adapter configuration failed on attempt ${attempt}.`,
          );
          if (attempt < maxAttempts) await this.delay(DELAYS_MS.RETRY);
          continue; // Try next attempt
        }

        // Send VIN request and handle the response including FC optimization
        const rawResponse = await this._sendVINRequestAndProcess();

        // If the request process failed (returned null)
        if (rawResponse === null) {
          void log.warn(
            `[${this.constructor.name}] Failed to retrieve raw response for VIN on attempt ${attempt}.`,
          );
          // If protocol state is ERROR, stop retrying
          if (this.protocolState === PROTOCOL_STATES.ERROR) {
            void log.error(
              `[${this.constructor.name}] Protocol entered ERROR state, stopping retries.`,
            );
            break;
          }
          if (attempt < maxAttempts) await this.delay(DELAYS_MS.RETRY);
          continue; // Try next attempt
        }

        // --- Process the successful raw response ---
        void log.debug(
          `[${this.constructor.name}] Raw VIN response received: ${rawResponse}`,
        );

        // Assemble potentially multi-frame response
        const assembledResponse = assembleMultiFrameResponse(rawResponse);
        void log.debug(
          `[${this.constructor.name}] Assembled VIN response data: ${assembledResponse}`,
        );

        // Parse the VIN from the assembled hex data
        const vin = parseVinFromResponse(assembledResponse);

        if (vin) {
          // Basic validation check
          const isValidVin =
            vin.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin);
          if (isValidVin) {
            void log.info(`[${this.constructor.name}] Valid VIN found: ${vin}`);
            return vin; // Success! Exit loop and return VIN.
          } else {
            void log.warn(
              `[${this.constructor.name}] Invalid VIN format received: ${vin}`,
            );
            // Consider if invalid format should be returned or treated as failure
            return vin; // Returning potentially invalid VIN for now
          }
        } else {
          void log.warn(
            `[${this.constructor.name}] Failed to parse VIN from response on attempt ${attempt}.`,
          );
          // If parsing failed, continue to retry
          if (attempt < maxAttempts) await this.delay(DELAYS_MS.RETRY);
        }
      } catch (error: unknown) {
        // Catch unexpected errors during the attempt
        const errorMsg = error instanceof Error ? error.message : String(error);
        void log.error(
          `[${this.constructor.name}] Error during VIN retrieval attempt ${attempt}:`,
          {
            error: errorMsg,
            stack: error instanceof Error ? error.stack : undefined,
          },
        );
        this.protocolState = PROTOCOL_STATES.ERROR; // Mark as error
        // Decide whether to retry on general error
        if (attempt < maxAttempts) {
          void log.debug(`[${this.constructor.name}] Retrying after error...`);
          await this.delay(DELAYS_MS.RETRY);
        } else {
          break; // Exit loop if max attempts reached
        }
      }
    } // End while loop

    void log.error(
      `[${this.constructor.name}] Failed to retrieve VIN after ${maxAttempts} attempts.`,
    );
    return null; // Failed after all attempts
  }

  /**
   * Resets the internal state of the retriever.
   */
  public resetState(): void {
    this.isCan = false;
    this.protocolNumber = PROTOCOL.AUTO; // Reset to default
    this.protocolType = PROTOCOL_TYPES.UNKNOWN;
    this.headerFormat = HEADER_FORMATS.UNKNOWN;
    this.ecuResponseHeader = null; // Reset detected header
    this.protocolState = PROTOCOL_STATES.INITIALIZED;
    this.isHeaderEnabled = false; // Must be true for VIN retrieval, set in config
    void log.debug(`[${this.constructor.name}] State reset.`);
  }

  // Method for consistency if needed elsewhere
  public getServiceMode(): ServiceMode {
    return VINRetriever.SERVICE_MODE;
  }
}
