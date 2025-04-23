import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';
import {
  parseVinFromResponse,
  isResponseError,
  assembleMultiFrameResponse,
  isVinResponseFrame,
} from '../utils/helpers';
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

  private async _initializeForVIN(): Promise<boolean> {
    const currentState = ecuStore.getState();
    // Only configure if headers aren't already enabled
    if (!this.isHeaderEnabled) {
      try {
        const response = await this.sendCommand('ATH1');
        if (!response || isResponseError(response)) {
          void log.warn('[VINRetriever] Failed to enable headers');
          return false;
        }
        this.isHeaderEnabled = true;
      } catch (error) {
        void log.warn('[VINRetriever] Error enabling headers:', error);
        return false;
      }
    }

    // Check if we need Flow Control for CAN
    if (this.isCan && 
        currentState.activeProtocol && 
        this.protocolState !== PROTOCOL_STATES.READY) {
      await this._configureForProtocol();
    }

    return true;
  }

  private isErrorResponse(response: string | null): boolean {
    return response === null || isResponseError(response);
  }

  /**
   * Check for negative response codes from ECU
   * @param response The response string to check
   * @returns true if response indicates an error or unsupported command
   */
  private isNegativeResponse(response: string): boolean {
    // Common negative response codes for Mode 09 (VIN)
    const negativePatterns = [
      /7F\s*09\s*([0-9A-F]{2})/i, // General negative response
      /7F\s*01\s*31/i,     // Request out of range
      /7F\s*09\s*31/i,     // Request out of range
      /7F\s*09\s*11/i,     // Service not supported  
      /7F\s*09\s*12/i      // Sub-function not supported
    ];

    return negativePatterns.some(pattern => {
      const match = response.match(pattern);
      if (match) {
        void log.warn('[VINRetriever] Negative response:', {
          pattern: pattern.source,
          response,
          code: match[1]
        });
        return true;
      }
      return false;
    });
  }

  /**
   * Get human-readable meaning of NRC (Negative Response Code)
   */
  private getNrcMeaning(nrcCode: string): string {
    const nrcMeanings: Record<string, string> = {
      '11': 'Service not supported',
      '12': 'Sub-function not supported',
      '31': 'Request out of range',
      '33': 'Security access denied',
      '7F': 'General reject',
    };
    return nrcMeanings[nrcCode.toUpperCase()] || 'Unknown error';
  }

  /**
   * Configure protocol-specific settings for VIN retrieval
   */
  private async _configureForProtocol(): Promise<void> {
    if (!this.isCan || !this.ecuResponseHeader) {
      void log.debug(
        '[VINRetriever] Skipping protocol config - not CAN or no ECU header',
      );
      return;
    }

    const flowControlCommands = [
      { cmd: `ATFCSH${this.ecuResponseHeader}`, desc: 'Set FC Header' },
      { cmd: 'ATFCSD300008', desc: 'Set FC Data (BS=0,ST=8ms)' },
      { cmd: 'ATFCSM1', desc: 'Enable FC' },
    ];

    for (const { cmd, desc } of flowControlCommands) {
      try {
        void log.debug(`[VINRetriever] ${desc}: ${cmd}`);
        await this.sendCommand(cmd, 2000);
        await this.delay(DELAYS_MS.COMMAND_SHORT);
      } catch (error) {
        void log.warn(`[VINRetriever] Flow Control command failed: ${cmd}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private convertChunkToHex(chunk: Uint8Array): string {
    // Type-safe conversion and filtering
    return Array.from(chunk)
      .map((byte: number): string => {
        // Filter known control characters explicitly
        if (byte === 0x0D || byte === 0x3E || byte === 0x20) {
          return '';
        }
        return byte.toString(16).padStart(2, '0').toUpperCase();
      })
      .filter((hex: string): boolean => hex.length > 0)
      .join('');
  }

  private processResponseChunks(chunks: Uint8Array[]): string {
    if (!chunks?.length) {
      void log.warn('[VINRetriever] No chunks to process');
      return '';
    }

    // Process all chunks to hex
    const hexString = chunks
      .map((chunk: Uint8Array): string => this.convertChunkToHex(chunk))
      .join('');

    void log.debug('[VINRetriever] Raw hex response:', hexString);

    if (!hexString) {
      void log.warn('[VINRetriever] No hex data after conversion');
      return '';
    }

    // Use helper to assemble multiframe response if needed
    const assembledResponse = assembleMultiFrameResponse(hexString);
    
    // Only try VIN parsing if we have a VIN frame
    if (isVinResponseFrame(assembledResponse)) {
      const vin = parseVinFromResponse(assembledResponse);
      if (vin) {
        void log.info('[VINRetriever] Found VIN:', vin);
        return vin;
      }
    }

    return assembledResponse;
  }

  public async retrieveVIN(): Promise<string | null> {
    const currentState = ecuStore.getState();
    if (currentState.status !== ECUConnectionStatus.CONNECTED) {
      void log.error('[VINRetriever] ECU not connected');
      return null;
    }

    // Update protocol settings from store
    this.protocolNumber = currentState.activeProtocol ?? PROTOCOL.AUTO;
    this.isCan = this.protocolNumber >= 6 && this.protocolNumber <= 20;
    this.ecuResponseHeader = currentState.selectedEcuAddress ?? 
                           currentState.detectedEcuAddresses?.[0] ?? 
                           null;

    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        // Initialize using text-based AT commands
        await this._initializeForVIN();

        // VIN requests use bluetoothSendCommandRawChunked for binary data
        const vinRequests = [
          '0902',      // Standard Mode 9 PID 2 request
          '0902FF',    // Extended request
          '09020000',  // Padded request
        ];

        for (const request of vinRequests) {
          try {
            // Use raw chunked mode for VIN data
            const rawResponse = await this.bluetoothSendCommandRawChunked(request, {
              timeout: VINRetriever.DATA_TIMEOUT,
            });

            void log.debug('[VINRetriever] Raw chunks:', 
              rawResponse.chunks.map(chunk => Array.from(chunk)));

            // Process binary chunks
            const hexResponse = this.processResponseChunks(rawResponse.chunks);
            void log.debug('[VINRetriever] Hex response:', hexResponse);

            if (this.isNegativeResponse(hexResponse)) {
              void log.warn(`[VINRetriever] ECU rejected ${request}`);
              continue;
            }

            const vin = parseVinFromResponse(hexResponse);
            if (vin) {
              void log.info(`[VINRetriever] Found VIN: ${vin}`);
              return vin;
            }
          } catch (error) {
            void log.warn(`[VINRetriever] Error with ${request}:`, error);
          }
        }

        // Configure protocol using text-based AT commands
        if (attempt < maxAttempts) {
          await this._configureForProtocol();
          await this.delay(DELAYS_MS.RETRY * 2);
        }
      } catch (error) {
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
