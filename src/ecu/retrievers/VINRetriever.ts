import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';
import { parseVinFromResponse, isResponseError } from '../utils/helpers';
import {
  DELAYS_MS,
  STANDARD_PIDS,
  PROTOCOL,
  ECUConnectionStatus,
} from '../utils/constants';

import type { ECUState } from '../utils/types';
import type { ServiceMode } from './types';
import type { SendCommandFunction, ChunkedResponse } from '../utils/types';

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
  private readonly bluetoothSendCommandRawChunked: (
    command: string,
    timeout?: number | { timeout?: number },
  ) => Promise<ChunkedResponse>;

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

  constructor(
    sendCommand: SendCommandFunction,
    bluetoothSendCommandRawChunked: (
      command: string,
      timeout?: number | { timeout?: number },
    ) => Promise<ChunkedResponse>,
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
   * Configure adapter specifically for VIN retrieval.
   * Includes reset, basic settings, protocol detection, ECU header detection, and specific config.
   */
  private async _configureAdapterForVIN(): Promise<boolean> {
    void log.info('[VINRetriever] Configuring adapter for VIN retrieval...');

    if (this.protocolState === PROTOCOL_STATES.READY) {
      void log.debug('[VINRetriever] Adapter already configured');
      return true;
    }

    this.protocolState = PROTOCOL_STATES.CONFIGURING;

    try {
      // Reset adapter first
      await this.sendCommand('ATZ');
      await this.delay(1000); // Longer delay after reset

      // Basic configuration commands with better validation
      const commands = [
        {
          cmd: 'ATE0',
          delay: 200,
          desc: 'Echo off',
          validate: (resp: string) =>
            resp.includes('OK') || resp.includes('ATE0'),
        },
        {
          cmd: 'ATL0',
          delay: 100,
          desc: 'Linefeeds off',
          validate: (resp: string) =>
            resp.includes('OK') || resp.includes('ATL0'),
        },
        {
          cmd: 'ATS0',
          delay: 100,
          desc: 'Spaces off',
          validate: (resp: string) =>
            resp.includes('OK') || resp.includes('ATS0'),
        },
        {
          cmd: 'ATH1',
          delay: 100,
          desc: 'Headers on',
          validate: (resp: string) =>
            resp.includes('OK') || resp.includes('ATH1'),
        },
        {
          cmd: 'ATAT1',
          delay: 100,
          desc: 'Adaptive timing on',
          validate: (resp: string) =>
            resp.includes('OK') || resp.includes('ATAT1'),
        },
      ];

      for (const { cmd, delay, desc, validate } of commands) {
        const response = await this.sendCommand(cmd);
        if (!response || (!validate(response) && !isResponseError(response))) {
          void log.warn(`[VINRetriever] ${desc} returned: ${response}`);
          if (cmd === 'ATH1') {
            throw new Error('Headers must be enabled for VIN retrieval');
          }
        }
        await this.delay(delay);
      }

      // Verify communication
      const testResponse = await this.sendCommand('ATI');
      if (!testResponse || isResponseError(testResponse)) {
        void log.warn(
          `[VINRetriever] Communication test failed: ${testResponse}`,
        );
        throw new Error('Communication test failed');
      }

      void log.info('[VINRetriever] Adapter configuration complete');
      return true;
    } catch (error) {
      void log.error('[VINRetriever] Configuration failed:', error);
      this.protocolState = PROTOCOL_STATES.ERROR;
      return false;
    }
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

  private isNegativeResponse(response: string): boolean {
    // Check for 7F responses which indicate "not supported" or other errors
    const negativeMatch = response.match(/7F\s*09\s*([0-9A-F]{2})/i);
    if (negativeMatch) {
      const nrcCode = negativeMatch[1];
      void log.warn('[VINRetriever] Received negative response:', { 
        code: nrcCode,
        meaning: this.getNrcMeaning(nrcCode)
      });
      return true;
    }
    return false;
  }

  private getNrcMeaning(nrcCode: string): string {
    const nrcMeanings: Record<string, string> = {
      '11': 'Service not supported',
      '12': 'Sub-function not supported',
      '31': 'Request out of range',
      '33': 'Security access denied',
      '7F': 'General reject'
    };
    return nrcMeanings[nrcCode.toUpperCase()] || 'Unknown error';
  }

  // Add interface for library errors
  private isBluetoothLibraryError(error: unknown): boolean {
    if (!error) return false;
    const errorObj = error as { constructor?: { name: string } };
    return (
      typeof errorObj === 'object' &&
      errorObj?.constructor?.name?.includes('Ble') ||
      String(error).toLowerCase().includes('bluetooth')
    );
  }

  public async retrieveVIN(): Promise<string | null> {
    if (this.ecuState.status !== ECUConnectionStatus.CONNECTED) {
      void log.error('[VINRetriever] ECU not connected');
      return null;
    }

    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        // Configure adapter if needed
        const configResult = await this._configureAdapterForVIN();
        if (!configResult) {
          void log.warn(`[VINRetriever] Adapter configuration failed on attempt ${attempt}`);
          continue;
        }

        try {
          // Use bluetoothSendCommandRawChunked with library error detection
          const rawResponse = await this.bluetoothSendCommandRawChunked('0902', {
            timeout: VINRetriever.DATA_TIMEOUT,
          });

          // Validate raw response structure
          if (!rawResponse?.chunks?.length) {
            void log.warn(`[VINRetriever] Invalid chunked response on attempt ${attempt}`);
            continue;
          }

          // Process each chunk with error handling
          const processedChunks: string[] = [];
          const decoder = new TextDecoder();

          // Log raw chunks for debugging
          void log.debug('[VINRetriever] Raw chunks received:', 
            rawResponse.chunks.map(chunk => Array.from(chunk)));

          for (const chunk of rawResponse.chunks) {
            try {
              if (!(chunk instanceof Uint8Array)) {
                void log.warn('[VINRetriever] Invalid chunk type, expected Uint8Array');
                continue;
              }
              const decodedChunk = decoder.decode(chunk).trim();
              if (decodedChunk && !decodedChunk.match(/^[\r\n>]*$/)) {
                processedChunks.push(decodedChunk);
              }
            } catch (e) {
              void log.warn('[VINRetriever] Error decoding chunk:', e);
              continue;
            }
          }

          // Combine and clean processed chunks
          const stringResponse = processedChunks
            .join(' ')
            .replace(/[\r\n>]/g, '')
            .trim();

          void log.debug('[VINRetriever] Processed response:', stringResponse);

          // Check for negative response before attempting to parse VIN
          if (this.isNegativeResponse(stringResponse)) {
            void log.warn(`[VINRetriever] ECU rejected VIN request on attempt ${attempt}`);
            // Try protocol-specific configuration before next attempt
            await this._configureForProtocol();
            if (attempt < maxAttempts) {
              await this.delay(DELAYS_MS.RETRY);
              continue;
            }
            return null;
          }

          // Continue with VIN parsing...
          const vin = parseVinFromResponse(stringResponse);
          
          if (vin) {
            void log.info(`[VINRetriever] VIN retrieved successfully: ${vin}`);
            return vin;
          }

          void log.warn(
            `[VINRetriever] Failed to parse VIN from response on attempt ${attempt}`,
            { response: stringResponse },
          );

          if (attempt < maxAttempts) await this.delay(DELAYS_MS.RETRY);

        } catch (error: unknown) {
          // Handle library-specific errors with proper typing
          const errorMsg = error instanceof Error ? error.message : String(error);
          void log.error('[VINRetriever] Library Error:', {
            error: errorMsg,
            errorType: error instanceof Error ? error.constructor.name : 'Unknown',
            attempt,
            source: 'bluetooth-library',
          });
          
          // Check if it's a library-specific error using helper method
          if (this.isBluetoothLibraryError(error)) {
            if (attempt < maxAttempts) {
              void log.info('[VINRetriever] Detected library error, retrying after delay...');
              await this.delay(DELAYS_MS.RETRY * 2); // Longer delay for library errors
              continue;
            }
          }
          throw error; // Re-throw if it's not a library error or we're out of attempts
        }
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        void log.error(`[VINRetriever] Error on attempt ${attempt}:`, {
          error: errorMsg,
          stack: error instanceof Error ? error.stack : undefined,
        });
        
        if (attempt < maxAttempts) {
          await this.delay(DELAYS_MS.RETRY);
          continue;
        }
      }
    }

    void log.error('[VINRetriever] Failed to retrieve VIN after all attempts');
    return null;
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
