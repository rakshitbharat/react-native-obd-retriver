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

  private async _initializeForVIN(): Promise<boolean> {
    // Slow initialization sequence for problematic ECUs
    const initCommands = [
      { cmd: 'ATZ', delay: 2000 }, // Longer delay after reset
      { cmd: 'ATI', delay: 300 }, // Get device info
      { cmd: 'ATDP', delay: 300 }, // Get protocol
      { cmd: 'ATE0', delay: 200 }, // Echo off
      { cmd: 'ATL0', delay: 200 }, // Linefeeds off
      { cmd: 'ATS0', delay: 200 }, // Spaces off
      { cmd: 'ATH1', delay: 200 }, // Headers on
      { cmd: 'ATAT1', delay: 200 }, // Adaptive timing on
      { cmd: 'ATST64', delay: 200 }, // Set timeout to 100ms (64 = hex 100ms)
      { cmd: 'ATFCSM1', delay: 200 }, // Enable flow control
      { cmd: 'ATCAF1', delay: 200 }, // Formatting on
    ];

    for (const { cmd, delay } of initCommands) {
      try {
        const response = await this.sendCommand(cmd);
        if (!response) {
          void log.warn(`[VINRetriever] No response for ${cmd}`);
          continue;
        }
        await this.delay(delay);
      } catch (error) {
        void log.warn(`[VINRetriever] Error sending ${cmd}:`, error);
      }
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
    // Common negative response codes:
    // 7F 09 11 = service not supported
    // 7F 09 12 = subfunction not supported
    // 7F 09 31 = request out of range
    const negativeMatch = response.match(/7F\s*09\s*([0-9A-F]{2})/i);
    if (negativeMatch) {
      const nrcCode = negativeMatch[1];
      void log.warn('[VINRetriever] Negative response:', {
        code: nrcCode,
        meaning: this.getNrcMeaning(nrcCode),
      });
      return true;
    }
    return false;
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
        // Initialize with slower sequence first
        await this._initializeForVIN();

        // Try different request variants
        const vinRequests = [
          '0902', // Standard request
          '0902FF', // Some ECUs need this variant
          '09020000', // Some ECUs need padding
        ];

        for (const request of vinRequests) {
          try {
            const rawResponse = await this.bluetoothSendCommandRawChunked(
              request,
              {
                timeout: VINRetriever.DATA_TIMEOUT,
              },
            );

            // Validate raw response structure
            if (!rawResponse?.chunks?.length) {
              void log.warn(
                `[VINRetriever] Invalid chunked response on attempt ${attempt}`,
              );
              continue;
            }

            // Process each chunk with error handling
            const processedChunks: string[] = [];
            const decoder = new TextDecoder();

            for (const chunk of rawResponse.chunks) {
              try {
                if (!(chunk instanceof Uint8Array)) continue;
                const decodedChunk = decoder.decode(chunk).trim();
                // Only add non-empty chunks that aren't just terminators
                if (decodedChunk && !decodedChunk.match(/^[\r\n>]*$/)) {
                  processedChunks.push(decodedChunk);
                }
              } catch (e) {
                continue;
              }
            }

            const stringResponse = processedChunks
              .join(' ')
              .replace(/[\r\n>]/g, '')
              .trim();

            // If we got a negative response, try next variant
            if (this.isNegativeResponse(stringResponse)) {
              void log.warn(
                `[VINRetriever] ECU rejected ${request}, trying next variant...`,
              );
              continue;
            }

            const vin = parseVinFromResponse(stringResponse);
            if (vin) return vin;
          } catch (error) {
            // Only log and continue to next variant
            void log.warn(`[VINRetriever] Error with ${request}:`, error);
          }
        }

        // If we get here, no variant worked, try protocol config
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
