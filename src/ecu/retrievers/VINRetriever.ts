import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';
import {
  DELAYS_MS,
  STANDARD_PIDS,
  PROTOCOL,
  ECUConnectionStatus,
} from '../utils/constants';
import { isResponseError } from '../utils/helpers';

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

  constructor(
    sendCommand: SendCommandFunction,
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
      // Basic configuration commands
      const commands = [
        { cmd: 'ATE0', delay: 100, desc: 'Echo off' },
        { cmd: 'ATL0', delay: 100, desc: 'Linefeeds off' },
        { cmd: 'ATS0', delay: 100, desc: 'Spaces off' },
        { cmd: 'ATH1', delay: 100, desc: 'Headers on' },
        { cmd: 'ATAT1', delay: 100, desc: 'Adaptive timing on' },
      ];

      for (const { cmd, delay, desc } of commands) {
        const response = await this.sendCommand(cmd);
        if (!response || isResponseError(response)) {
          void log.warn(`[VINRetriever] Failed to ${desc}: ${response}`);
          if (cmd === 'ATH1') {
            throw new Error('Headers must be enabled for VIN retrieval');
          }
        }
        await this.delay(delay);
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

  private processCanFrames(response: string): string {
    void log.debug('[VINRetriever] Processing CAN frames from:', response);

    // Remove any terminators and clean the response
    const cleanResponse = response.replace(/[\r\n>]/g, '').toUpperCase();

    // Split into individual frames and validate
    const frames = cleanResponse.match(/7E8[0-9A-F]+/g) || [];
    void log.debug('[VINRetriever] Found frames:', frames);

    if (frames.length === 0) {
      void log.warn('[VINRetriever] No valid CAN frames found');
      return '';
    }

    // Process and combine frame data
    const combinedData = frames
      .map(frame => frame.substring(4)) // Remove 7E8 header
      .join('');

    void log.debug('[VINRetriever] Combined frame data:', combinedData);
    return combinedData;
  }

  private extractVinFromHex(hexData: string): string | null {
    try {
      void log.debug('[VINRetriever] Extracting VIN from hex:', hexData);

      // The response format should be: 49 02 01 [VIN DATA]
      // Remove the service and PID bytes (4902) and first byte (01)
      const vinStart = hexData.indexOf('490201');
      if (vinStart === -1) {
        void log.warn('[VINRetriever] No VIN marker (490201) found');
        return null;
      }

      // Get the VIN portion after 490201
      const vinHex = hexData.substring(vinStart + 6);
      void log.debug('[VINRetriever] VIN hex data:', vinHex);

      // Convert hex to ASCII characters
      let vin = '';
      for (let i = 0; i < vinHex.length && vin.length < 17; i += 2) {
        const hex = vinHex.substring(i, i + 2);
        const ascii = String.fromCharCode(parseInt(hex, 16));
        if (/[A-HJ-NPR-Z0-9]/i.test(ascii)) {
          vin += ascii;
        }
      }

      void log.debug('[VINRetriever] Extracted VIN:', vin);

      // Validate VIN format
      if (vin.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
        void log.info('[VINRetriever] Valid VIN found:', vin);
        return vin;
      }

      void log.warn('[VINRetriever] Invalid VIN format:', vin);
      return null;
    } catch (error) {
      void log.error('[VINRetriever] Error extracting VIN:', error);
      return null;
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
        // Configure adapter if needed
        await this._configureAdapterForVIN();

        // Use bluetoothSendCommandRawChunked instead of regular sendCommand
        const response = await this.bluetoothSendCommandRawChunked('0902');

        if (!response) {
          void log.warn('[VINRetriever] No response received');
          continue;
        }

        // Convert raw chunks to hex string if needed
        let rawResponse: string;
        if (Array.isArray(response)) {
          rawResponse = response
            .map(chunk => Buffer.from(chunk).toString('hex').toUpperCase())
            .join('');
        } else {
          rawResponse = response;
        }

        void log.debug('[VINRetriever] Raw response:', rawResponse);

        // Process frames
        const processedData = this.processCanFrames(rawResponse);
        if (!processedData) {
          void log.warn('[VINRetriever] No valid data after processing frames');
          continue;
        }

        // Extract VIN
        const vin = this.extractVinFromHex(processedData);
        if (vin) return vin;

        void log.warn(
          `[VINRetriever] Attempt ${attempt} failed to find valid VIN`,
        );
        await this.delay(DELAYS_MS.RETRY);
      } catch (error) {
        void log.error('[VINRetriever] Error:', error);
        if (attempt < maxAttempts) await this.delay(DELAYS_MS.RETRY);
      }
    }

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
