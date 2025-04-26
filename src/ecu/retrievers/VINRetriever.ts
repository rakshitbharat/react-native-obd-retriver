import { log } from '../../utils/logger';
import { getStore } from '../context/ECUStore';
import { VinDecoder } from 'obd-raw-data-parser';
import { processVINResponse } from '../utils/responseHandler';
import { VIN_CONSTANTS } from './vinConstants';
import type { SendCommandFunction, SendCommandRawFunction } from './types';

export class VINRetriever {
  private sendCommand: SendCommandFunction;
  private currentFunctionalHeader: string | null = null;

  constructor(
    sendCommand: SendCommandFunction,
    // sendCommandRaw is required by interface but not used in this implementation
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    sendCommandRaw: SendCommandRawFunction,
  ) {
    this.sendCommand = sendCommand;
  }

  private async delay(ms: number): Promise<void> {
    const finalDelay = Math.max(ms, 50); // Ensure minimum delay
    await new Promise(resolve => setTimeout(resolve, finalDelay));
  }

  private async setHeader(header: string): Promise<boolean> {
    const cmd = `ATSH${header}`;
    const response = await this.sendCommand(cmd);
    if (!response || response.includes('?') || response.includes('ERROR')) {
      log.warn(`[VINRetriever] Failed to set header ${header}`);
      return false;
    }
    this.currentFunctionalHeader = header;
    return true;
  }

  private async setFlowControlParams(config: {
    fcsh: string;
    fcsd: string;
    fcsm: string;
  }): Promise<boolean> {
    // Set flow control parameters with proper delays
    await this.sendCommand(`ATFCSH${config.fcsh}`);
    await this.delay(VIN_CONSTANTS.DELAYS.FLOW_CONTROL);
    await this.sendCommand(`ATFCSD${config.fcsd}`);
    await this.delay(VIN_CONSTANTS.DELAYS.FLOW_CONTROL);
    await this.sendCommand(`ATFCSM${config.fcsm}`);
    await this.delay(VIN_CONSTANTS.DELAYS.FLOW_CONTROL);
    return true;
  }

  private async sendVINRequest(): Promise<string | null> {
    const response = await this.sendCommand('0902');
    if (!response) return null;

    // Use the new response handler
    return processVINResponse(response);
  }

  public async retrieveVIN(): Promise<string | null> {
    try {
      const state = getStore();
      if (!state.activeProtocol || state.status !== 'CONNECTED') {
        log.error('[VINRetriever] Not connected or no protocol active');
        return null;
      }

      // Initialize with basic settings
      for (const { cmd } of VIN_CONSTANTS.INIT_COMMANDS) {
        await this.sendCommand(cmd);
        await this.delay(VIN_CONSTANTS.DELAYS.STANDARD);
      }

      // Set protocol explicitly
      await this.sendCommand(`ATSP${state.activeProtocol}`);
      await this.delay(200);

      // Try standard 11-bit CAN first
      await this.setHeader(VIN_CONSTANTS.HEADERS.CAN_11BIT);
      let vinResponse = await this.sendVINRequest();

      if (!vinResponse) {
        // Try 29-bit CAN
        await this.setHeader(VIN_CONSTANTS.HEADERS.CAN_29BIT);
        vinResponse = await this.sendVINRequest();
      }

      if (!vinResponse) {
        // Try with flow control
        const flowConfigs = VIN_CONSTANTS.FLOW_CONTROL_CONFIGS;

        for (const config of flowConfigs) {
          await this.setFlowControlParams(config);
          vinResponse = await this.sendVINRequest();
          if (vinResponse) break;
          await this.delay(200);
        }
      }

      if (vinResponse) {
        try {
          // Try both segmented and non-segmented VIN decoding
          const vinHex = vinResponse.replace(/\s+/g, '').replace(/>/g, '');
          let vin = VinDecoder.processVINResponse(vinHex);
          if (!vin) {
            vin = VinDecoder.processVINSegments(vinHex);
          }
          if (vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
            log.info(`[VINRetriever] Successfully retrieved VIN: ${vin}`);
            return vin;
          }
        } catch (e) {
          log.error('[VINRetriever] Error decoding VIN response:', e);
        }
      }

      return null;
    } catch (error) {
      log.error('[VINRetriever] Error retrieving VIN:', error);
      return null;
    }
  }
}
