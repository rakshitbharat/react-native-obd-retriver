import { log } from '../../utils/logger';
import { getStore } from '../context/ECUStore';
import { processVINResponse } from '../utils/responseHandler';
import { DELAYS_MS } from '../utils/constants';
import type { SendCommandFunction, SendCommandRawFunction } from './types';

// Constants for VIN retrieval
const VIN_CONSTANTS = {
  HEADERS: {
    CAN_11BIT: '7DF',
    CAN_29BIT: '18DB33F1',
  },
  FLOW_CONTROL: {
    CAN_11BIT: {
      SEND_ID: '7E0',
      RECEIVE_ID: '7E8',
      FLOW_ID: '7E0',
    },
    CAN_29BIT: {
      SEND_ID: '18DA10F1',
      RECEIVE_ID: '18DAF110',
      FLOW_ID: '18DA10F1',
    },
  },
  DELAYS: {
    INIT: 300,
    FLOW_CONTROL: 100,
    RETRY: 2000,
  },
  INIT_COMMANDS: [
    { cmd: 'ATZ', delay: 1000 },
    { cmd: 'ATE0', delay: 100 },
    { cmd: 'ATL0', delay: 100 },
    { cmd: 'ATH1', delay: 100 },
    { cmd: 'ATCAF1', delay: 100 },
  ],
};

function decodeVINResponse(vinHex: string): string | null {
  try {
    // Remove any whitespace and '>' prompts
    const cleanHex = vinHex.replace(/\s+|>/g, '').toUpperCase();

    // Remove service mode and PID bytes if present (4902)
    const dataHex = cleanHex.replace(/^4902/, '');

    // Convert hex pairs to ASCII, filtering non-printable characters
    const chars: string[] = [];
    for (let i = 0; i < dataHex.length; i += 2) {
      const hex = dataHex.substring(i, i + 2);
      const charCode = parseInt(hex, 16);
      // Only allow printable ASCII characters (32-126)
      if (charCode >= 32 && charCode <= 126) {
        chars.push(String.fromCharCode(charCode));
      }
    }

    const vin = chars.join('').trim();
    return /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin) ? vin : null;
  } catch {
    log.error('[VINRetriever] Error decoding VIN response');
    return null;
  }
}

export class VINRetriever {
  private readonly sendCommand: SendCommandFunction;
  private maxRetries = 3;
  private retryDelay = 2000;
  private currentFlowConfig: {
    sendId: string;
    receiveId: string;
    flowId: string;
  } | null = null;

  constructor(
    sendCommand: SendCommandFunction,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    sendCommandRaw: SendCommandRawFunction,
  ) {
    this.sendCommand = sendCommand;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, Math.max(ms, 50)));
  }

  private async configureFlowControl(isExtended: boolean): Promise<void> {
    const config = isExtended
      ? VIN_CONSTANTS.FLOW_CONTROL.CAN_29BIT
      : VIN_CONSTANTS.FLOW_CONTROL.CAN_11BIT;

    this.currentFlowConfig = {
      sendId: config.SEND_ID,
      receiveId: config.RECEIVE_ID,
      flowId: config.FLOW_ID,
    };

    // Set flow control
    await this.sendCommand(`ATFCSH${config.FLOW_ID}`);
    await this.delay(DELAYS_MS.COMMAND_SHORT);
    await this.sendCommand('ATFCSD300000');
    await this.delay(DELAYS_MS.COMMAND_SHORT);
    await this.sendCommand('ATFCSM1');
    await this.delay(DELAYS_MS.COMMAND_SHORT);
  }

  private async setHeader(header: string): Promise<boolean> {
    const response = await this.sendCommand(`ATSH${header}`);
    if (!response || response.includes('?') || response.includes('ERROR')) {
      await log.warn(`[VINRetriever] Failed to set header ${header}`);
      return false;
    }
    return true;
  }

  private async initializeAdapter(): Promise<void> {
    // Reset and initialize
    for (const { cmd, delay } of VIN_CONSTANTS.INIT_COMMANDS) {
      await this.sendCommand(cmd);
      await this.delay(delay);
    }
  }

  private async sendVINRequest(): Promise<string | null> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await log.debug(
        `[VINRetriever] VIN Request Attempt ${attempt}/${this.maxRetries}`,
      );

      try {
        let response = await this.sendCommand('0902');

        // Handle initial response patterns
        if (!response) {
          await this.delay(this.retryDelay);
          continue;
        }

        // Clean the response
        response = response.replace(/\r|\n|>|\s/g, '').toUpperCase();

        // Check for error conditions
        if (
          response.includes('NO DATA') ||
          response.includes('ERROR') ||
          response.includes('UNABLE') ||
          response.includes('?')
        ) {
          await log.debug(
            '[VINRetriever] Error response received, retrying...',
          );
          await this.delay(this.retryDelay);
          continue;
        }

        // Handle multi-frame responses
        if (response.includes('SEARCHING') || response.endsWith('62')) {
          await this.delay(500); // Wait for potential multi-frame message
          response = await this.sendCommand('');
        }

        // Process response
        const processedResponse = processVINResponse(response);
        if (processedResponse) {
          return processedResponse;
        }

        await this.delay(this.retryDelay);
      } catch (error) {
        await log.error(`[VINRetriever] Error in attempt ${attempt}:`, error);
        await this.delay(this.retryDelay);
      }
    }

    await log.warn('[VINRetriever] Failed to get VIN after all retries');
    return null;
  }

  public async retrieveVIN(): Promise<string | null> {
    try {
      const state = getStore();
      if (!state.activeProtocol || state.status !== 'CONNECTED') {
        await log.error('[VINRetriever] Not connected or no protocol active');
        return null;
      }

      // Initialize adapter
      await this.initializeAdapter();

      // Set protocol explicitly
      await this.sendCommand(`ATSP${state.activeProtocol}`);
      await this.delay(500);

      // Try CAN protocols in order: 11-bit, then 29-bit if needed
      const protocols = [
        { header: VIN_CONSTANTS.HEADERS.CAN_11BIT, isExtended: false },
        { header: VIN_CONSTANTS.HEADERS.CAN_29BIT, isExtended: true },
      ];

      for (const { header, isExtended } of protocols) {
        // Configure flow control first
        await this.configureFlowControl(isExtended);

        // Set header
        if (await this.setHeader(header)) {
          const vinResponse = await this.sendVINRequest();
          if (vinResponse) {
            try {
              const vin = decodeVINResponse(vinResponse);
              if (vin) {
                await log.info(
                  `[VINRetriever] Successfully retrieved VIN: ${vin}`,
                );
                return vin;
              }
            } catch (e) {
              await log.error('[VINRetriever] Error decoding VIN response:', e);
            }
          }
        }

        // Small delay before trying next protocol
        await this.delay(300);
      }

      await log.warn(
        '[VINRetriever] Failed to retrieve valid VIN with any protocol configuration',
      );
      return null;
    } catch (error) {
      await log.error('[VINRetriever] Error retrieving VIN:', error);
      return null;
    }
  }
}
