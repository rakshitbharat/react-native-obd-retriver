import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';
import {
  parseVinFromResponse,
  isResponseError,
  assembleMultiFrameResponse
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

export class VINRetriever {
  static SERVICE_MODE: ServiceMode = {
    REQUEST: STANDARD_PIDS.VIN,
    RESPONSE: 0x49,
    NAME: 'VEHICLE_VIN',
    DESCRIPTION: 'Vehicle Identification Number',
    troubleCodeType: 'INFO',
  };

  private static readonly DATA_TIMEOUT = 10000;

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
      if (!this.isHeaderEnabled) {
        const response = await this.sendCommand('ATH1');
        if (!this.isValidResponse(response)) {
          void log.warn('[VINRetriever] Failed to enable headers');
          return false;
        }
        this.isHeaderEnabled = true;
      }

      const currentState = ecuStore.getState();
      if (this.isCan && 
          typeof currentState.activeProtocol === 'number' && 
          this.protocolState !== 'READY') {
        await this._configureForProtocol();
      }

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      void log.error('[VINRetriever] Initialization error:', {
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined
      });
      return false;
    }
  }

  private isValidResponse(response: string | null): boolean {
    return response !== null && !isResponseError(response);
  }

  private isNegativeResponse(response: string): boolean {
    type NegativePattern = {
      pattern: RegExp;
      description: string;
    };

    const negativePatterns: readonly NegativePattern[] = [
      { 
        pattern: /7F\s*09\s*([0-9A-F]{2})/i,
        description: 'General negative response'
      },
      {
        pattern: /7F\s*0[19]\s*31/i,
        description: 'Request out of range'
      },
      {
        pattern: /7F\s*09\s*1[12]/i,
        description: 'Service/subfunction not supported'
      }
    ] as const;

    return negativePatterns.some(({ pattern, description }) => {
      const match = response.match(pattern);
      if (match) {
        void log.warn('[VINRetriever] Negative response:', {
          type: description,
          pattern: pattern.source,
          response,
          code: match[1] || 'unknown'
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

  private async _configureFlowControl(): Promise<boolean> {
    if (!this.isCan || !this.ecuResponseHeader) {
      void log.debug('[VINRetriever] Skipping flow control - not CAN or no ECU header');
      return false;
    }

    const fcCommands: readonly FlowControlCommand[] = [
      { cmd: 'ATFCSH7E8', desc: 'Set Flow Control Send Header', timeout: 2000 },
      { cmd: 'ATFCRH7E0', desc: 'Set Flow Control Receive Header', timeout: 2000 },
      { cmd: 'ATFCSD300010', desc: 'Set Flow Control Send Data (BS=48,ST=16ms)', timeout: 2000 },
      { cmd: 'ATFCSM1', desc: 'Enable Flow Control', timeout: 2000 },
      { cmd: 'ATST64', desc: 'Set timeout to 100ms * 64', timeout: 1000 },
      { cmd: 'ATSTFF', desc: 'Set maximum response timeout', timeout: 1000 }
    ] as const;

    for (const {cmd, desc, timeout} of fcCommands) {
      try {
        void log.debug(`[VINRetriever] ${desc}: ${cmd}`);
        const response = await this.sendCommand(cmd, timeout && { timeout });
        
        if (!response || isResponseError(response)) {
          void log.warn(`[VINRetriever] Flow Control command failed: ${cmd}`);
          return false;
        }
        
        await this.delay(DELAYS_MS.COMMAND_SHORT);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        void log.error(`[VINRetriever] Flow Control error:`, {
          command: cmd,
          error: errorMsg,
          stack: error instanceof Error ? error.stack : undefined
        });
        return false;
      }
    }

    return true;
  }

  private async _sendVinRequest(request: string): Promise<ChunkedResponse | null> {
    try {
      const timeout: { timeout: number } = { timeout: VINRetriever.DATA_TIMEOUT };
      
      const fcConfigured = await this._configureFlowControl();
      if (!fcConfigured) {
        void log.warn('[VINRetriever] Flow control configuration failed');
      }

      const response = await this.bluetoothSendCommandRawChunked(request, timeout);
      
      // Disable flow control after request
      await this.sendCommand('ATFCSM0', { timeout: 2000 });
      
      return response;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      void log.error(`[VINRetriever] VIN request failed: ${request}`, {
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined
      });
      return null;
    }
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
        await this._initializeForVIN();

        const vinRequests = [
          '0902',      // Standard
          '0902FF',    // Extended
          '09020000'   // Padded
        ];

        for (const request of vinRequests) {
          const rawResponse = await this._sendVinRequest(request);
          if (!rawResponse) continue;

          // Process response...
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

    const validBytes = new Set<number>([0x0D, 0x3E, 0x20]); // Control chars to filter

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
        stack: error instanceof Error ? error.stack : undefined
      });
      return '';
    }
  }
}
