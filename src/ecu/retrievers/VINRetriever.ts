import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';
import {
  ELM_COMMANDS,
  DELAYS_MS,
  RESPONSE_KEYWORDS,
  STANDARD_PIDS,
  PROTOCOL,
  ECUConnectionStatus,
} from '../utils/constants';
import {
  isResponseError,
  isResponseOk,
  extractProtocolNumber,
  extractEcuAddresses,
} from '../utils/helpers';

// Add helper functions that were missing
const assembleMultiFrameResponse = (response: string): string => {
  // Remove headers and spaces, keep only data portion
  const cleaned = response.replace(/\s+/g, '');
  if (cleaned.includes('NODATA') || cleaned.length < 8) return cleaned;

  // For CAN responses starting with headers like 7E8
  if (cleaned.match(/^[0-9A-F]{3}/)) {
    const lines = cleaned.split(/(?=[0-9A-F]{3})/);
    return lines.map(line => line.substring(3)).join('');
  }

  return cleaned;
};

const parseVinFromResponse = (response: string): string | null => {
  if (!response || response.includes('NODATA')) return null;

  // Remove any spaces and convert to uppercase
  const cleaned = response.replace(/\s+/g, '').toUpperCase();

  // Look for 49 02 (VIN response identifier) followed by data
  const vinMatch = cleaned.match(/49020[0-9A-F]+/);
  if (!vinMatch) return null;

  // Extract the data portion after 49 02
  const vinHex = vinMatch[0].substring(4);
  
  // Convert hex to ASCII, 2 characters at a time
  const vinChars = [];
  for (let i = 0; i < vinHex.length; i += 2) {
    const hex = vinHex.substring(i, i + 2);
    vinChars.push(String.fromCharCode(parseInt(hex, 16)));
  }

  const vin = vinChars.join('');
  return vin.length === 17 ? vin : null;
};

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

  // Add ecuState property
  private readonly ecuState: ECUState;

  constructor(sendCommand: SendCommandFunction) {
    this.sendCommand = sendCommand;
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
      this.ecuResponseHeader = currentState.selectedEcuAddress;
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
      { fcsh: '18DAF110', fcsd: '300810', fcsm: '1' }
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
      } catch (error) {
        continue;
      }
    }
    return false;
  }

  private async _sendVINRequestAndProcess(): Promise<string | null> {
    try {
      if (this.protocolState !== PROTOCOL_STATES.READY) {
        void log.warn(
          `[${this.constructor.name}] Protocol not ready (State: ${this.protocolState}). Aborting command ${this.mode}.`
        );
        this.protocolState = PROTOCOL_STATES.ERROR;
        return null;
      }

      const result = await this._sendCommandWithTiming(
        this.mode,
        VINRetriever.DATA_TIMEOUT
      );

      if (result === null || this.isErrorResponse(result)) {
        void log.warn(
          `[${this.constructor.name}] Error or no response for command ${this.mode}: ${result ?? 'null'}`
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
          `[${this.constructor.name}] Detected potential CAN flow control issue. Response: ${result}. Attempting optimization...`
        );
        const flowControlSuccess = await this._tryOptimizeFlowControl();

        if (flowControlSuccess) {
          void log.debug(
            `[${this.constructor.name}] Retrying command ${this.mode} after flow control optimization...`
          );
          const retryResult = await this._sendCommandWithTiming(
            this.mode,
            VINRetriever.DATA_TIMEOUT,
          );

          if (retryResult && !this.isErrorResponse(retryResult)) {
            void log.info(
              `[${this.constructor.name}] Successfully received response after flow control optimization.`
            );
            return retryResult;
          } else {
            void log.warn(
              `[${this.constructor.name}] Command ${this.mode} still failed after optimization. Response: ${retryResult ?? 'null'}`
            );
          }
        } else {
          void log.warn(
            `[${this.constructor.name}] Flow control optimization failed. Proceeding with original response.`
          );
        }
      }

      void log.debug(
        `[${this.constructor.name}] Processing final response for command ${this.mode}: ${result}`
      );
      return result;
    } catch (error) {
      void log.error(
        `[${this.constructor.name}] Error during command execution:`,
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }
      );
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
