import { log } from '../../utils/logger'; // Import logger

import { BaseDTCRetriever, type RawDTCResponse } from './BaseDTCRetriever';

import type { ServiceMode } from './types';
import type { SendCommandFunction } from '../utils/types';

export class CurrentDTCRetriever extends BaseDTCRetriever {
  // Add detailed service mode constant to match JavaScript implementation
  static SERVICE_MODE: ServiceMode = {
    REQUEST: '03',
    RESPONSE: 0x43,
    NAME: 'CURRENT_DTC',
    DESCRIPTION: 'Current DTCs',
    troubleCodeType: 'TROUBLE_CODES',
  };

  constructor(sendCommand: SendCommandFunction) {
    super(sendCommand, CurrentDTCRetriever.SERVICE_MODE.REQUEST);
  }

  /**
   * Overrides retrieveRawDTCs to use the base class logic directly.
   * The base class now handles configuration, command sending, retries,
   * and response processing including NO DATA checks.
   */
  public override async retrieveRawDTCs(): Promise<RawDTCResponse | null> {
    await log.debug(
      `[${this.constructor.name}] Retrieving raw DTCs using base class method...`,
    );
    try {
      // Call the base class method which handles the full retrieval process
      const result = await super.retrieveRawDTCs();

      if (result) {
        await log.debug(
          `[${this.constructor.name}] Successfully retrieved raw DTCs.`,
        );
      } else {
        await log.warn(
          `[${this.constructor.name}] Failed to retrieve raw DTCs.`,
        );
      }
      return result;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.error(`[${this.constructor.name}] Error retrieving raw DTCs:`, {
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

  // No need to override sendCommandWithTiming anymore, base class handles it.

  // Add return type annotation to fix lint error
  public getServiceMode(): ServiceMode {
    return CurrentDTCRetriever.SERVICE_MODE;
  }
}
