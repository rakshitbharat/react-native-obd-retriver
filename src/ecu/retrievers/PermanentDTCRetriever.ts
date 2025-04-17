import { log } from '../../utils/logger'; // Import logger

import { BaseDTCRetriever, type RawDTCResponse } from './BaseDTCRetriever';

import type { ServiceMode } from './types';
import type { SendCommandFunction } from '../utils/types';

/**
 * Specializes in retrieving permanent Diagnostic Trouble Codes
 * 
 * The PermanentDTCRetriever class uses OBD Service Mode 0A (10) to retrieve 
 * permanent DTCs from the vehicle's diagnostic system. These are special codes
 * that persist in memory even after clearing DTCs and disconnecting the battery.
 * 
 * Key features:
 * - Retrieves permanent/non-erasable fault codes
 * - Uses OBD service mode 0A (0x0A)
 * - Identifies issues that require specific repair verification
 * - Essential for emissions compliance and inspection readiness
 * - Supported primarily in newer vehicles (2010+)
 * 
 * Permanent DTCs are critical for:
 * - Emissions testing compliance
 * - Verifying complete repairs of critical systems
 * - Monitoring vehicle readiness for inspection
 * - Detecting tampering with emissions systems
 * 
 * Note: Not all vehicles support Mode 0A (permanent DTCs), particularly 
 * vehicles manufactured before 2010. The feature is primarily required for 
 * emissions compliance in modern vehicles.
 * 
 * @example
 * ```typescript
 * // Create a retriever instance
 * const permanentRetriever = new PermanentDTCRetriever(sendCommand);
 * 
 * // Retrieve and check permanent DTCs
 * const dtcResponse = await permanentRetriever.retrieveRawDTCs();
 * 
 * if (dtcResponse) {
 *   if (dtcResponse.troubleCodes && dtcResponse.troubleCodes.length > 0) {
 *     console.log(`Found ${dtcResponse.troubleCodes.length} permanent DTCs:`);
 *     console.log("Vehicle will NOT pass emissions inspection until fixed:");
 *     dtcResponse.troubleCodes.forEach(dtc => {
 *       console.log(`- ${dtc}`); // e.g., "P0420", "P0455"
 *     });
 *   } else {
 *     console.log("No permanent DTCs found. Vehicle ready for inspection.");
 *   }
 * } else {
 *   console.error("Failed to retrieve permanent DTCs or not supported");
 * }
 * ```
 */
export class PermanentDTCRetriever extends BaseDTCRetriever {
  // Add detailed service mode constant to match JavaScript implementation
  static SERVICE_MODE: ServiceMode = {
    REQUEST: '0A',
    RESPONSE: 0x4a, // Corrected response code (0x4A = 74 decimal)
    NAME: 'PERMANENT_DTC',
    DESCRIPTION: 'Permanent DTCs',
    troubleCodeType: 'P_TROUBLE_CODES',
  };

  constructor(sendCommand: SendCommandFunction) {
    super(sendCommand, PermanentDTCRetriever.SERVICE_MODE.REQUEST);
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
    return PermanentDTCRetriever.SERVICE_MODE;
  }
}
