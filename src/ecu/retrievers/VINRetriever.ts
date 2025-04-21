import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';
import {
  DELAYS_MS,
  RESPONSE_KEYWORDS,
  STANDARD_PIDS,
  PROTOCOL,
  ECUConnectionStatus,
} from '../utils/constants';
import {
  isResponseError,
  parseVinFromResponse,
  assembleMultiFrameResponse,
} from '../utils/helpers';

import type { ECUState } from '../utils/types';
import type { ServiceMode } from './types';
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
  private readonly bluetoothSendCommandRawChunked: SendCommandFunction;

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

  // Add ecuState property
  private readonly ecuState: ECUState;

  constructor(sendCommand: SendCommandFunction,
    bluetoothSendCommandRawChunked: SendCommandFunction,
  ) {
    this.sendCommand = sendCommand;
    this.bluetoothSendCommandRawChunked = bluetoothSendCommandRawChunked;
    const currentState = ecuStore.getState();
    this.ecuState = currentState;

    // Initialize state from existing ECU connection
    if (
      currentState.status === ECUConnectionStatus.CONNECTED &&
      currentState.activeProtocol !== null
    ) {
      this.protocolNumber = currentState.activeProtocol;
      this.isCan = this.protocolNumber >= 6 && this.protocolNumber <= 20;
      this.protocolType = this.isCan
        ? PROTOCOL_TYPES.CAN
        : PROTOCOL_TYPES.UNKNOWN;
      this.headerFormat = this.isCan
        ? this.protocolNumber % 2 === 0
          ? HEADER_FORMATS.CAN_11BIT
          : HEADER_FORMATS.CAN_29BIT
        : HEADER_FORMATS.UNKNOWN;
      // Use selectedEcuAddress if available, otherwise use first from detectedEcuAddresses
      this.ecuResponseHeader =
        currentState.selectedEcuAddress ??
        currentState.detectedEcuAddresses?.[0] ??
        null;
      this.protocolState = PROTOCOL_STATES.READY;
    }
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
   * Applies protocol-specific configurations, including default CAN Flow Control using detected header if available.
   */
  private async _configureForProtocol(): Promise<void> {
    // Only configure if we're already connected
    if (
      this.ecuState.status !== ECUConnectionStatus.CONNECTED ||
      this.ecuState.activeProtocol === null
    ) {
      void log.error(
        `[${this.constructor.name}] ECU not connected or invalid protocol. Cannot configure.`,
      );
      this.protocolState = PROTOCOL_STATES.ERROR;
      return;
    }

    if (this.isCan) {
      // Minimal CAN configuration focusing on Flow Control
      const fcHeader = this.ecuResponseHeader || '7E8';

      const flowControlCommands = [
        { cmd: `ATFCSH${fcHeader}`, desc: 'Set FC Header' },
        { cmd: 'ATFCSD300008', desc: 'Set FC Data (BS=0,ST=8ms)' },
        { cmd: 'ATFCSM1', desc: 'Enable FC' },
      ];

      for (const { cmd, desc } of flowControlCommands) {
        try {
          void log.debug(`[${this.constructor.name}] ${desc}: ${cmd}`);
          await this.sendCommand(cmd, 2000);
          await this.delay(DELAYS_MS.COMMAND_SHORT);
        } catch (error) {
          void log.warn(
            `[${this.constructor.name}] Flow Control command failed: ${cmd}`,
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }
    // No additional configuration needed for other protocols
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
    if (!this.isCan || !this.ecuState.activeProtocol) return false;

    const configs: Array<{
      fcsh: string;
      fcsd: string;
      fcsm: string;
    }> = [
      // Progressive block sizes with increasing separation time
      { fcsh: '7E8', fcsd: '300000', fcsm: '1' }, // Standard
      { fcsh: '7E8', fcsd: '300204', fcsm: '1' }, // BS=2, ST=4ms
      { fcsh: '7E8', fcsd: '300408', fcsm: '1' }, // BS=4, ST=8ms
      { fcsh: '7E8', fcsd: '300810', fcsm: '1' }, // BS=8, ST=16ms
      // Try 29-bit headers if needed
      { fcsh: '18DAF110', fcsd: '300000', fcsm: '1' },
      { fcsh: '18DAF110', fcsd: '300810', fcsm: '1' },
    ];

    for (const config of configs) {
      try {
        await this.sendCommand(`ATFCSH${config.fcsh}`, 2000);
        await this.delay(50);
        await this.sendCommand(`ATFCSD${config.fcsd}`, 2000);
        await this.delay(50);
        await this.sendCommand(`ATFCSM${config.fcsm}`, 2000);
        await this.delay(50);

        // Test with VIN request
        const response = await this._sendCommandWithTiming(this.mode, 5000);

        if (
          response &&
          !this.isErrorResponse(response) &&
          response.includes('49') &&
          response.length > 20
        ) {
          this.ecuResponseHeader = config.fcsh;
          return true;
        }
      } catch {
        // Handle error case without using error variable
      }
    }
    return false;
  }

  private parseCanVinResponse(rawResponse: string): string | null {
    try {
      void log.debug(`[${this.constructor.name}] Raw CAN response: ${rawResponse}`);
      
      // Initial cleanup - remove prompt and whitespace
      const response = rawResponse.replace(/[>\r\n\s]/g, '').toUpperCase();
      void log.debug(`[${this.constructor.name}] Cleaned response: ${response}`);

      // Parse CAN frames - match frames with format 7ExYY... where x is frame number
      const frames = response.match(/7E[0-9][0-9A-F]+/g) || [];
      void log.debug(`[${this.constructor.name}] Parsed frames:`, frames);

      if (frames.length === 0) {
        void log.warn(`[${this.constructor.name}] No valid CAN frames found`);
        return null;
      }

      // Extract and order the data from frames
      let vinHexString = '';
      for (const frame of frames) {
        // Skip first 4 chars (7Ex8) for first frame, 4 chars (7Ex8) for consecutive
        const dataStart = frame.startsWith('7E8') ? 8 : 4;
        const data = frame.substring(dataStart);
        vinHexString += data;
      }

      void log.debug(`[${this.constructor.name}] Combined hex data: ${vinHexString}`);

      // Find start of VIN data after service 09 PID 02 (4902)
      const serviceMatch = vinHexString.match(/4902[0-9A-F]+/);
      if (!serviceMatch) {
        void log.warn(`[${this.constructor.name}] No service 09 PID 02 marker found`);
        return null;
      }

      // Extract the actual VIN data after 4902
      const vinHexData = serviceMatch[0].substring(4);
      void log.debug(`[${this.constructor.name}] VIN hex data: ${vinHexData}`);

      // Convert hex to ASCII characters
      let vin = '';
      for (let i = 0; i < vinHexData.length && vin.length < 17; i += 2) {
        const hexPair = vinHexData.substring(i, i + 2);
        const charCode = parseInt(hexPair, 16);
        
        // Only include valid VIN characters
        const char = String.fromCharCode(charCode);
        if (/[A-HJ-NPR-Z0-9]/i.test(char)) {
          vin += char;
        } else {
          void log.warn(
            `[${this.constructor.name}] Invalid VIN character: ${char} (hex: ${hexPair})`
          );
        }
      }

      void log.debug(`[${this.constructor.name}] Extracted VIN: ${vin}`);

      // Validate final VIN
      if (vin.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
        void log.info(`[${this.constructor.name}] Valid VIN found: ${vin}`);
        return vin;
      }

      void log.warn(
        `[${this.constructor.name}] Invalid VIN format: ${vin} (length: ${vin.length})`
      );
      return null;

    } catch (error) {
      void log.error(`[${this.constructor.name}] Error parsing CAN VIN response:`, {
        error: error instanceof Error ? error.message : String(error),
        raw: rawResponse
      });
      return null;
    }
  }

  private async _sendVINRequestAndProcess(): Promise<string | null> {
    try {
      if (this.protocolState !== PROTOCOL_STATES.READY) {
        void log.warn(
          `[${this.constructor.name}] Protocol not ready (State: ${this.protocolState}). Aborting command ${this.mode}.`,
        );
        this.protocolState = PROTOCOL_STATES.ERROR;
        return null;
      }

      const result = await this._sendCommandWithTiming(
        this.mode,
        VINRetriever.DATA_TIMEOUT,
      );

      if (result === null || this.isErrorResponse(result)) {
        void log.warn(
          `[${this.constructor.name}] Error or no response for command ${this.mode}: ${result ?? 'null'}`,
        );
        if (
          result !== null &&
          (result.includes('UNABLE') ||
            result.includes('BUS ERROR') ||
            result.includes('TIMEOUT'))
        ) {
          this.protocolState = PROTOCOL_STATES.ERROR;
        }
        return null;
      }

      // Flow Control Check (CAN only)
      const needsFlowControlCheck =
        this.isCan &&
        (result.includes(RESPONSE_KEYWORDS.BUFFER_FULL) ||
          result.includes(RESPONSE_KEYWORDS.FB_ERROR) ||
          (result.length > 0 &&
            result.length < 20 &&
            !result.includes(RESPONSE_KEYWORDS.NO_DATA)));

      if (needsFlowControlCheck) {
        void log.debug(
          `[${this.constructor.name}] Detected potential CAN flow control issue. Response: ${result}. Attempting optimization...`,
        );
        const flowControlSuccess = await this._tryOptimizeFlowControl();

        if (flowControlSuccess) {
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
            return retryResult;
          } else {
            void log.warn(
              `[${this.constructor.name}] Command ${this.mode} still failed after optimization. Response: ${retryResult ?? 'null'}`,
            );
          }
        } else {
          void log.warn(
            `[${this.constructor.name}] Flow control optimization failed. Proceeding with original response.`,
          );
        }
      }

      void log.debug(
        `[${this.constructor.name}] Processing final response for command ${this.mode}: ${result}`,
      );
      return result;
    } catch {
      // Handle error case without using error variable
      this.protocolState = PROTOCOL_STATES.ERROR;
      return null;
    }
  }

  /**
   * Retrieves and parses the VIN.
   * Orchestrates configuration, command sending, retries, and parsing.
   */
  public async retrieveVIN(): Promise<string | null> {
    // Verify ECU is connected and has valid protocol
    if (
      this.ecuState.status !== ECUConnectionStatus.CONNECTED ||
      this.ecuState.activeProtocol === null
    ) {
      void log.error(
        `[${this.constructor.name}] ECU not connected or invalid protocol. Cannot retrieve VIN.`,
      );
      return null;
    }

    void log.debug(
      `[${this.constructor.name}] Attempting to retrieve VIN using existing connection...`,
    );
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        // Configure Flow Control if needed
        await this._configureForProtocol();

        // Send VIN request and handle response
        const rawResponse = await this._sendVINRequestAndProcess();

        console.log('rawResponse', JSON.stringify(await this.bluetoothSendCommandRawChunked('0902')));

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

        // Try CAN-specific parsing first if we're using a CAN protocol
        if (this.isCan) {
          const canVin = this.parseCanVinResponse(rawResponse);
          if (canVin) {
            void log.info(`[${this.constructor.name}] Valid VIN found: ${canVin}`);
            return canVin;
          }
        }

        // Fall back to standard parsing if CAN parsing fails
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
    this.protocolNumber = PROTOCOL.AUTO;
    this.protocolType = PROTOCOL_TYPES.UNKNOWN;
    this.headerFormat = HEADER_FORMATS.UNKNOWN;
    this.ecuResponseHeader = null;
    this.protocolState = PROTOCOL_STATES.INITIALIZED;
    this.isHeaderEnabled = false;
    void log.debug(`[${this.constructor.name}] State reset.`);
  }

  // Method for consistency if needed elsewhere
  public getServiceMode(): ServiceMode {
    return VINRetriever.SERVICE_MODE;
  }
}
