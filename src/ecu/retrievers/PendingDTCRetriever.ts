import { log } from '../../utils/logger'; // Import logger

import { BaseDTCRetriever, type RawDTCResponse } from './BaseDTCRetriever';

import type { ServiceMode } from './types';
import type { SendCommandFunction } from '../utils/types';

/**
 * Specializes in retrieving pending/intermittent Diagnostic Trouble Codes
 *
 * The PendingDTCRetriever class uses OBD Service Mode 07 to retrieve pending DTCs
 * from the vehicle's diagnostic system. These are codes for issues that have been
 * detected but haven't yet triggered the Malfunction Indicator Light (MIL).
 *
 * Key features:
 * - Retrieves pending/intermittent fault codes
 * - Uses OBD service mode 07 (0x07)
 * - Helps identify developing problems before they become active DTCs
 * - Works across all OBD-II compliant vehicles that support Mode 07
 * - Provides early diagnostic indications
 *
 * Pending DTCs are especially valuable for:
 * - Preventative maintenance
 * - Detecting intermittent issues
 * - Verifying repairs before clearing active DTCs
 * - Monitoring borderline component performance
 *
 * @example
 * ```typescript
 * // Create a retriever instance
 * const pendingRetriever = new PendingDTCRetriever(sendCommand);
 *
 * // Retrieve and parse pending DTCs
 * const dtcResponse = await pendingRetriever.retrieveRawDTCs();
 *
 * if (dtcResponse) {
 *   if (dtcResponse.troubleCodes && dtcResponse.troubleCodes.length > 0) {
 *     console.log(`Found ${dtcResponse.troubleCodes.length} pending DTCs:`);
 *     dtcResponse.troubleCodes.forEach(dtc => {
 *       console.log(`- ${dtc}`); // e.g., "P0456", "P0442"
 *     });
 *   } else {
 *     console.log("No pending DTCs found.");
 *   }
 * } else {
 *   console.error("Failed to retrieve pending DTCs");
 * }
 * ```
 */
export class PendingDTCRetriever extends BaseDTCRetriever {
  // Add detailed service mode constant to match JavaScript implementation
  static SERVICE_MODE: ServiceMode = {
    REQUEST: '07',
    RESPONSE: 0x47,
    NAME: 'PENDING_DTC',
    DESCRIPTION: 'Pending DTCs',
    troubleCodeType: 'U_TROUBLE_CODES',
  };

  constructor(sendCommand: SendCommandFunction) {
    super(sendCommand, PendingDTCRetriever.SERVICE_MODE.REQUEST);
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
    return PendingDTCRetriever.SERVICE_MODE;
  }
}
