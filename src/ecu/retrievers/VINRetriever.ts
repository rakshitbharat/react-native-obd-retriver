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

interface ChunkedResponse {
  chunks: Array<{ [key: number]: number }>;
  command: string;
  totalBytes: number;
  rawResponse: number[][];
}

type SendCommandRawFunction = (
  command: string,
  options?: number | { timeout?: number },
) => Promise<string | ChunkedResponse | null>;

// Protocol/State constants needed internally
const PROTOCOL_TYPES = {
  CAN: 'CAN',
  KWP: 'KWP',
  ISO9141: 'ISO9141',
  J1850: 'J1850',
  UNKNOWN: 'UNKNOWN',
} as const;
type ProtocolType = (typeof PROTOCOL_TYPES)[keyof typeof PROTOCOL_TYPES];

const HEADER_FORMATS = {
  CAN_11BIT: '11bit',
  CAN_29BIT: '29bit',
  KWP: 'kwp',
  ISO9141: 'iso9141',
  J1850: 'j1850',
  UNKNOWN: 'unknown',
} as const;
type HeaderFormat = (typeof HEADER_FORMATS)[keyof typeof HEADER_FORMATS];

const PROTOCOL_STATES = {
  INITIALIZED: 'INITIALIZED',
  CONFIGURING: 'CONFIGURING',
  READY: 'READY',
  ERROR: 'ERROR',
} as const;
type ProtocolState = (typeof PROTOCOL_STATES)[keyof typeof PROTOCOL_STATES];

/**
 * VINRetriever class for handling Vehicle Identification Number retrieval
 * with special support for J1939 protocol
 */
export class VINRetriever {
  // Static constants
  private static readonly J1939_HEADERS = {
    REQUEST: '18EAFFF9', // VIN request using PGN 65259 (FEEC)
    RESPONSE: '18EBFF00', // Expected response header
    FLOW_CONTROL: 'ATFCSH18EBFF', // Flow control header
  };

  static readonly SERVICE_MODE: ServiceMode = {
    REQUEST: STANDARD_PIDS.VIN, // '0902'
    RESPONSE: 0x49,
    NAME: 'VEHICLE_VIN',
    DESCRIPTION: 'Vehicle Identification Number',
    troubleCodeType: 'INFO',
  };

  // Timeout constants
  private static readonly DATA_TIMEOUT = 10000;
  private static readonly COMMAND_TIMEOUT = 5000;

  // Instance properties
  private readonly sendCommand: SendCommandFunction;
  private readonly bluetoothSendCommandRawChunked: SendCommandRawFunction;
  private readonly ecuState: ECUState;
  private readonly mode: string = VINRetriever.SERVICE_MODE.REQUEST;

  // Protocol and state tracking
  private isCan: boolean = false;
  private isJ1939: boolean = false;
  private protocolNumber: PROTOCOL | number = PROTOCOL.AUTO;
  private protocolType: ProtocolType = PROTOCOL_TYPES.UNKNOWN;
  private headerFormat: HeaderFormat = HEADER_FORMATS.UNKNOWN;
  private ecuResponseHeader: string | null = null;
  private protocolState: ProtocolState = PROTOCOL_STATES.INITIALIZED;
  private isHeaderEnabled: boolean = false;

  constructor(
    sendCommand: SendCommandFunction,
    bluetoothSendCommandRawChunked: SendCommandRawFunction,
  ) {
    this.sendCommand = sendCommand;
    this.bluetoothSendCommandRawChunked = bluetoothSendCommandRawChunked;
    const currentState = ecuStore.getState();
    this.ecuState = currentState;

    if (
      currentState.status === ECUConnectionStatus.CONNECTED &&
      currentState.activeProtocol !== null
    ) {
      this.protocolNumber = currentState.activeProtocol;
      this.isCan = this.protocolNumber >= 6 && this.protocolNumber <= 20;
      this.isJ1939 = this.protocolNumber === 10; // Protocol 10 is J1939
      this.protocolType = this.isCan
        ? PROTOCOL_TYPES.CAN
        : PROTOCOL_TYPES.UNKNOWN;
      this.headerFormat = this.isCan
        ? this.protocolNumber % 2 === 0
          ? HEADER_FORMATS.CAN_11BIT
          : HEADER_FORMATS.CAN_29BIT
        : HEADER_FORMATS.UNKNOWN;

      this.ecuResponseHeader = this.isJ1939
        ? VINRetriever.J1939_HEADERS.RESPONSE
        : (currentState.selectedEcuAddress ??
          currentState.detectedEcuAddresses?.[0] ??
          null);

      this.protocolState = PROTOCOL_STATES.READY;
    }
  }

  // Helper method to create a delay
  private delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Configure adapter specifically for VIN retrieval
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
        { cmd: 'ATCAF1', delay: 100, desc: 'Formatting on' },
        {
          cmd: this.isJ1939 ? 'ATSP10' : 'ATSP0',
          delay: 200,
          desc: 'Set protocol',
        },
      ];

      if (this.isJ1939) {
        // J1939 specific configuration
        commands.push(
          {
            cmd: `ATSH${VINRetriever.J1939_HEADERS.REQUEST}`,
            delay: 100,
            desc: 'Set header',
          },
          {
            cmd: VINRetriever.J1939_HEADERS.FLOW_CONTROL,
            delay: 100,
            desc: 'Set flow control',
          },
          { cmd: 'ATFCSD300000', delay: 100, desc: 'Set flow control data' },
          { cmd: 'ATFCSM1', delay: 100, desc: 'Enable flow control' },
        );
      } else if (this.isCan) {
        // Standard CAN configuration
        const header = this.ecuResponseHeader || '7E0';
        commands.push(
          { cmd: `ATSH${header}`, delay: 100, desc: 'Set header' },
          { cmd: 'ATFCSH7E0', delay: 100, desc: 'Set flow control header' },
          { cmd: 'ATFCSD300000', delay: 100, desc: 'Set flow control data' },
          { cmd: 'ATFCSM1', delay: 100, desc: 'Enable flow control' },
        );
      }

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
      this.protocolState = PROTOCOL_STATES.READY;
      return true;
    } catch (error) {
      void log.error('[VINRetriever] Configuration failed:', error);
      this.protocolState = PROTOCOL_STATES.ERROR;
      return false;
    }
  }

  /**
   * Process CAN frames from the response
   */
  private processCanFrames(response: string): string {
    void log.debug('[VINRetriever] Processing CAN frames from:', response);

    // Remove any terminators and clean the response
    const cleanResponse = response.replace(/[\r\n>]/g, '').toUpperCase();

    // For J1939, match frames with the correct header
    const framePattern = this.isJ1939
      ? new RegExp(
          `${VINRetriever.J1939_HEADERS.RESPONSE.replace('0', '')}[0-9A-F]+`,
          'g',
        )
      : /7E8[0-9A-F]+/g;

    const frames = cleanResponse.match(framePattern) || [];
    void log.debug('[VINRetriever] Found frames:', frames);

    if (frames.length === 0) {
      void log.warn('[VINRetriever] No valid CAN frames found');
      return '';
    }

    // Process and combine frame data
    const headerLength = this.isJ1939 ? 8 : 3; // J1939 headers are 8 chars, standard CAN 3 chars
    const combinedData = frames
      .map(frame => frame.substring(headerLength)) // Remove header
      .join('');

    void log.debug('[VINRetriever] Combined frame data:', combinedData);
    return combinedData;
  }

  /**
   * Extract and validate VIN from hex data
   */
  private extractVinFromHex(hexData: string): string | null {
    try {
      void log.debug('[VINRetriever] Extracting VIN from hex:', hexData);

      // J1939 has a different response format, handle it separately
      const vinHex = this.isJ1939
        ? hexData // J1939 response is direct VIN data
        : (() => {
            // Standard OBD-II format: 49 02 01 [VIN DATA]
            const vinStart = hexData.indexOf('490201');
            if (vinStart === -1) {
              void log.warn('[VINRetriever] No VIN marker (490201) found');
              return null;
            }
            return hexData.substring(vinStart + 6);
          })();

      if (!vinHex) return null;

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

  /**
   * Retrieves the Vehicle Identification Number
   * Handles both standard OBD-II and J1939 protocols
   */
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
        // Configure adapter
        const configSuccess = await this._configureAdapterForVIN();
        if (!configSuccess) {
          void log.error('[VINRetriever] Adapter configuration failed');
          continue;
        }

        // Different request format for J1939 vs standard OBD-II
        const command = this.isJ1939 ? 'FEEC' : '0902';
        const response = await this.bluetoothSendCommandRawChunked(command);

        if (!response) {
          void log.warn('[VINRetriever] No response received');
          await this.delay(DELAYS_MS.RETRY);
          continue;
        }

        // Convert response to a hex string format we can process
        let rawResponse: string;
        if (typeof response === 'string') {
          // Handle string response directly
          rawResponse = response;
        } else if (Array.isArray(response)) {
          // Handle array of bytes
          rawResponse = response
            .map((chunk: number[] | Uint8Array) => Buffer.from(chunk).toString('hex').toUpperCase())
            .join('');
        } else if (response instanceof Object && 'chunks' in response) {
          // Handle ChunkedResponse type
          const chunkedResponse = response as ChunkedResponse;
          // Convert raw response array to hex string
          rawResponse = chunkedResponse.rawResponse
            .map((bytes: number[]) => Buffer.from(bytes).toString('hex').toUpperCase())
            .join('');
        } else {
          void log.warn('[VINRetriever] Unexpected response type:', {
            response,
          });
          await this.delay(DELAYS_MS.RETRY);
          continue;
        }

        void log.debug('[VINRetriever] Raw response:', rawResponse);

        // Process frames based on protocol
        const processedData = this.processCanFrames(rawResponse);
        if (!processedData) {
          void log.warn('[VINRetriever] No valid data after processing frames');
          await this.delay(DELAYS_MS.RETRY);
          continue;
        }

        // Extract and validate VIN
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
   * Reset the retriever's internal state
   */
  public resetState(): void {
    this.isCan = false;
    this.isJ1939 = false;
    this.protocolNumber = PROTOCOL.AUTO;
    this.protocolType = PROTOCOL_TYPES.UNKNOWN;
    this.headerFormat = HEADER_FORMATS.UNKNOWN;
    this.ecuResponseHeader = null;
    this.protocolState = PROTOCOL_STATES.INITIALIZED;
    this.isHeaderEnabled = false;
  }
}
