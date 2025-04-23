import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';
import {
  parseVinFromResponse,
  isResponseError,
  assembleMultiFrameResponse,
} from '../utils/helpers';
import {
  DELAYS_MS,
  STANDARD_PIDS,
  PROTOCOL,
  ECUConnectionStatus,
} from '../utils/constants';

import type { ServiceMode } from './types';
import type { SendCommandFunction, ChunkedResponse } from '../utils/types';

// Simplified protocol constants
const PROTOCOL_TYPES = {
  CAN: 'CAN',
  UNKNOWN: 'UNKNOWN',
} as const;
type ProtocolType = (typeof PROTOCOL_TYPES)[keyof typeof PROTOCOL_TYPES];

const PROTOCOL_STATES = {
  INITIALIZED: 'INITIALIZED',
  READY: 'READY',
} as const;
type ProtocolState = (typeof PROTOCOL_STATES)[keyof typeof PROTOCOL_STATES];

interface FlowControlCommand {
  readonly cmd: string;
  readonly desc: string;
  readonly timeout?: number;
}

interface FlowControlConfig {
  readonly header: string;
  readonly receiveFilter: string;
  readonly flowControl: string;
  readonly priority: number;
}

export class VINRetriever {
  static readonly SERVICE_MODE: ServiceMode = {
    REQUEST: STANDARD_PIDS.VIN, // '0902'
    RESPONSE: 0x49, // 73 decimal
    NAME: 'VEHICLE_VIN',
    DESCRIPTION: 'Vehicle Identification Number',
    troubleCodeType: 'INFO',
  };

  private static readonly MAX_RETRIES = 3;
  private static readonly DELAY_MS = 2000;
  private static readonly FLOW_CONTROL_CONFIGS: readonly FlowControlConfig[] = [
    {
      header: '7DF', // Try broadcast address first
      receiveFilter: '7E8',
      flowControl: '7E0',
      priority: 1,
    },
    {
      header: '7E0',
      receiveFilter: '7E8',
      flowControl: '7E0',
      priority: 2,
    },
    {
      header: '18DB33F1',
      receiveFilter: '18DAF110',
      flowControl: '18DA10F1',
      priority: 3,
    },
  ] as const;

  // Lock to prevent parallel VIN retrievals
  private static isRetrieving = false;

  private readonly sendCommand: SendCommandFunction;
  private readonly bluetoothSendCommandRawChunked: (
    command: string,
    timeout?: number | { timeout?: number },
  ) => Promise<ChunkedResponse>;

  private isCan: boolean = false;
  private protocolNumber: PROTOCOL | number = PROTOCOL.AUTO;
  private protocolType: ProtocolType = PROTOCOL_TYPES.UNKNOWN;
  private ecuResponseHeader: string | null = null;
  private protocolState: ProtocolState = PROTOCOL_STATES.INITIALIZED;
  private isHeaderEnabled: boolean = false;
  private currentFlowControlConfig: FlowControlConfig =
    VINRetriever.FLOW_CONTROL_CONFIGS[0];

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
      // Use selectedEcuAddress if available, otherwise use first from detectedEcuAddresses
      this.ecuResponseHeader =
        currentState.selectedEcuAddress ??
        currentState.detectedEcuAddresses?.[0] ??
        null;
      this.protocolState = PROTOCOL_STATES.READY;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  private async _initializeForVIN(): Promise<boolean> {
    try {
      // Reset flow control first
      await this.sendCommand('ATFCSM0');
      await this.delay(DELAYS_MS.COMMAND_SHORT);

      // Enable headers
      if (!this.isHeaderEnabled) {
        const response = await this.sendCommand('ATH1');
        if (!this.isValidResponse(response)) {
          void log.warn('[VINRetriever] Failed to enable headers');
          return false;
        }
        this.isHeaderEnabled = true;
      }

      const currentState = ecuStore.getState();
      if (
        this.isCan &&
        typeof currentState.activeProtocol === 'number' &&
        this.protocolState !== 'READY'
      ) {
        await this._configureForProtocol();
      }

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      void log.error('[VINRetriever] Initialization error:', {
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return false;
    }
  }

  private isValidResponse(response: string | null): boolean {
    return response !== null && !isResponseError(response);
  }

  private isNegativeResponse(response: string | null): boolean {
    if (!response) return false;

    type NegativePattern = {
      pattern: RegExp;
      description: string;
    };

    const negativePatterns: readonly NegativePattern[] = [
      {
        pattern: /7F\s*09\s*([0-9A-F]{2})/i,
        description: 'General negative response',
      },
      {
        pattern: /7F\s*0[19]\s*31/i,
        description: 'Request out of range',
      },
      {
        pattern: /7F\s*09\s*1[12]/i,
        description: 'Service/subfunction not supported',
      },
    ] as const;

    return negativePatterns.some(({ pattern, description }) => {
      const match = response.match(pattern);
      if (match) {
        void log.warn('[VINRetriever] Negative response:', {
          type: description,
          pattern: pattern.source,
          response,
          code: match[1] || 'unknown',
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
    if (!this.isCan) {
      void log.debug('[VINRetriever] Skipping protocol config - not CAN');
      return;
    }

    // Try each flow control configuration
    for (const config of VINRetriever.FLOW_CONTROL_CONFIGS) {
      try {
        // Set header
        await this.sendCommand(`ATSH${config.header}`);
        await this.delay(DELAYS_MS.COMMAND_SHORT);

        // Set receive filter
        await this.sendCommand(`ATCRA${config.receiveFilter}`);
        await this.delay(DELAYS_MS.COMMAND_SHORT);

        // Configure flow control
        await this.sendCommand(`ATFCSH${config.flowControl}`);
        await this.delay(DELAYS_MS.COMMAND_SHORT);

        // Test configuration with a simple request
        const testResponse = await this.sendCommand('0100');
        if (
          this.isValidResponse(testResponse) &&
          !this.isNegativeResponse(testResponse)
        ) {
          this.currentFlowControlConfig = config;
          void log.info(
            '[VINRetriever] Found working flow control config:',
            config,
          );
          return;
        }

        void log.debug('[VINRetriever] Flow control config failed:', config);
      } catch (error) {
        void log.warn('[VINRetriever] Error testing flow control config:', {
          config,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async _configureFlowControl(): Promise<boolean> {
    if (!this.isCan) {
      void log.debug('[VINRetriever] Skipping flow control - not CAN');
      return false;
    }

    // First reset any existing flow control
    await this.sendCommand('ATFCSM0');
    await this.delay(DELAYS_MS.COMMAND_SHORT);

    const { header, receiveFilter, flowControl } =
      this.currentFlowControlConfig;

    const fcCommands: readonly FlowControlCommand[] = [
      // Set protocol timing first
      { cmd: 'ATAT1', desc: 'Enable adaptive timing', timeout: 1000 },
      { cmd: 'ATST64', desc: 'Set timeout to 100ms * 64', timeout: 1000 },
      { cmd: 'ATSTFF', desc: 'Set maximum response timeout', timeout: 1000 },

      // Then configure headers and filters
      { cmd: `ATSH${header}`, desc: 'Set Header', timeout: 1000 },
      {
        cmd: `ATCRA${receiveFilter}`,
        desc: 'Set Flow Control Receive Filter',
        timeout: 1000,
      },
      {
        cmd: `ATFCSH${flowControl}`,
        desc: 'Set Flow Control Send Header',
        timeout: 1000,
      },

      // Finally set flow control parameters
      {
        cmd: 'ATFCSD300000',
        desc: 'Set Flow Control Send Data (no delay)',
        timeout: 1000,
      },
      { cmd: 'ATFCSM1', desc: 'Enable Flow Control', timeout: 1000 },
    ] as const;

    for (const { cmd, desc, timeout } of fcCommands) {
      try {
        void log.debug(`[VINRetriever] ${desc}: ${cmd}`);
        const response = await this.sendCommand(cmd);

        if (!response || isResponseError(response)) {
          void log.warn(`[VINRetriever] Flow Control command failed: ${cmd}`);
          return false;
        }

        await this.delay(timeout ?? DELAYS_MS.COMMAND_SHORT);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        void log.error(`[VINRetriever] Flow Control error:`, {
          command: cmd,
          error: errorMsg,
          stack: error instanceof Error ? error.stack : undefined,
        });
        return false;
      }
    }

    return true;
  }

  private async _sendVinRequest(
    request: string,
  ): Promise<ChunkedResponse | null> {
    try {
      // Configure flow control
      const fcConfigured = await this._configureFlowControl();
      if (!fcConfigured) {
        void log.warn('[VINRetriever] Flow control configuration failed');
      }

      // Try different request formats
      const requestFormats = [
        request, // Original format
        request.padEnd(8, '0'), // Padded to 8 bytes
        `${request}1`, // With length = 1
        `${request}00`, // With length = 0
      ];

      for (const reqFormat of requestFormats) {
        try {
          // Set header before each attempt
          if (this.currentFlowControlConfig) {
            await this.sendCommand(
              `ATSH${this.currentFlowControlConfig.header}`,
            );
            await this.delay(DELAYS_MS.COMMAND_SHORT);
          }

          // Send the request with extended timeout
          const response = await this.bluetoothSendCommandRawChunked(
            reqFormat,
            { timeout: 6000 },
          );

          if (response && response.chunks.length > 0) {
            return response;
          }

          void log.debug(`[VINRetriever] No response for format: ${reqFormat}`);
          await this.delay(DELAYS_MS.COMMAND_SHORT);
        } catch (error) {
          void log.warn(
            `[VINRetriever] Request failed for format: ${reqFormat}`,
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }

      // Disable flow control after all attempts
      await this.sendCommand('ATFCSM0');

      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      void log.error(`[VINRetriever] VIN request failed: ${request}`, {
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

  /**
   * Retrieves the Vehicle Identification Number (VIN) from the ECU
   * Using ISO-15765 protocol for CAN networks or ISO-14230 for K-Line
   *
   * @returns Promise resolving to 17-character VIN string or null if retrieval fails
   */
  public async retrieveVIN(): Promise<string | null> {
    // Prevent parallel retrievals
    if (VINRetriever.isRetrieving) {
      void log.warn('[VINRetriever] VIN retrieval already in progress');
      return null;
    }

    VINRetriever.isRetrieving = true;

    try {
      const currentState = ecuStore.getState();
      if (currentState.status !== ECUConnectionStatus.CONNECTED) {
        void log.error('[VINRetriever] ECU not connected');
        return null;
      }

      // Update protocol settings from store
      this.protocolNumber = currentState.activeProtocol ?? PROTOCOL.AUTO;
      this.isCan = this.protocolNumber >= 6 && this.protocolNumber <= 20;
      this.ecuResponseHeader =
        currentState.selectedEcuAddress ??
        currentState.detectedEcuAddresses?.[0] ??
        null;

      let attempt = 0;

      while (attempt < VINRetriever.MAX_RETRIES) {
        attempt++;

        try {
          // Initialize and verify headers are enabled
          await this._initializeForVIN();

          // Try each flow control config
          for (const config of VINRetriever.FLOW_CONTROL_CONFIGS) {
            this.currentFlowControlConfig = config;
            void log.info(`[VINRetriever] Trying flow control config:`, config);

            const vinRequests = [
              '0902', // Standard
              '0902FF', // Extended
              '09020000', // Padded
            ];

            for (const request of vinRequests) {
              const rawResponse = await this._sendVinRequest(request);
              if (!rawResponse) continue;

              // Process response...
              const hexResponse = this.processResponseChunks(
                rawResponse.chunks,
              );
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
            }

            // Add delay between config attempts
            await this.delay(DELAYS_MS.COMMAND_LONG);
          }

          if (attempt < VINRetriever.MAX_RETRIES) {
            await this.delay(VINRetriever.DELAY_MS);
          }
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          void log.error(`[VINRetriever] Error on attempt ${attempt}:`, {
            error: errorMsg,
            stack: error instanceof Error ? error.stack : undefined,
          });

          if (attempt < VINRetriever.MAX_RETRIES) {
            await this.delay(VINRetriever.DELAY_MS);
          }
        }
      }

      void log.error(
        '[VINRetriever] Failed to retrieve VIN after all attempts',
      );
      return null;
    } finally {
      VINRetriever.isRetrieving = false;
    }
  }

  public resetState(): void {
    this.isCan = false;
    this.protocolNumber = PROTOCOL.AUTO;
    this.protocolType = PROTOCOL_TYPES.UNKNOWN;
    this.ecuResponseHeader = null;
    this.protocolState = PROTOCOL_STATES.INITIALIZED;
    this.isHeaderEnabled = false;
    void log.debug(`[${this.constructor.name}] State reset.`);
  }

  private convertChunkToHex(chunk: Uint8Array): string {
    if (!chunk?.length) return '';

    const validBytes = new Set<number>([0x0d, 0x3e, 0x20]); // Control chars to filter

    return Array.from(chunk)
      .map((byte: number): string => {
        // Type guard for byte value
        if (typeof byte !== 'number' || byte < 0 || byte > 255) {
          void log.warn('[VINRetriever] Invalid byte value:', byte);
          return '';
        }
        // Filter known control characters
        if (validBytes.has(byte)) return '';
        return byte.toString(16).padStart(2, '0').toUpperCase();
      })
      .filter(Boolean)
      .join('');
  }

  private processResponseChunks(chunks: readonly Uint8Array[]): string {
    if (!Array.isArray(chunks) || !chunks.length) {
      void log.warn('[VINRetriever] Invalid or empty chunks array');
      return '';
    }

    try {
      // Convert raw chunks to hex string with validation
      const hexString = chunks
        .map((chunk: Uint8Array): string => {
          if (!(chunk instanceof Uint8Array)) {
            void log.warn('[VINRetriever] Invalid chunk type:', typeof chunk);
            return '';
          }
          return this.convertChunkToHex(chunk);
        })
        .filter(Boolean)
        .join('');

      void log.debug('[VINRetriever] Raw hex response:', hexString);

      if (!hexString) {
        void log.warn('[VINRetriever] No valid hex data after conversion');
        return '';
      }

      return assembleMultiFrameResponse(hexString);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      void log.error('[VINRetriever] Error processing chunks:', {
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return '';
    }
  }
}
