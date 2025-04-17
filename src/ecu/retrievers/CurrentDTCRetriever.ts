import { log } from '../../utils/logger'; // Import logger

import { BaseDTCRetriever, type RawDTCResponse } from './BaseDTCRetriever';

import type { ServiceMode } from './types';
import type { SendCommandFunction } from '../utils/types';

/**
 * Specializes in retrieving current (active) Diagnostic Trouble Codes
 *
 * The CurrentDTCRetriever class uses OBD Service Mode 03 to retrieve currently
 * active DTCs from the vehicle's diagnostic system. These are the codes that
 * typically trigger the Malfunction Indicator Light (MIL, or "Check Engine Light").
 *
 * Key features:
 * - Retrieves currently active fault codes
 * - Uses OBD service mode 03 (0x03)
 * - Works across all OBD-II compliant vehicles
 * - Handles multi-ECU responses
 * - Processes manufacturer-specific codes
 *
 * @example
 * ```typescript
 * // Create a retriever instance
 * const dtcRetriever = new CurrentDTCRetriever(sendCommand);
 *
 * // Retrieve and parse DTCs
 * const dtcResponse = await dtcRetriever.retrieveDTCs();
 *
 * if (dtcResponse) {
 *   // Check if any DTCs were found
 *   if (dtcResponse.length === 0) {
 *     console.log("No active DTCs found. No check engine light issues.");
 *   } else {
 *     console.log(`Found ${dtcResponse.length} active DTCs:`);
 *     dtcResponse.forEach(dtc => {
 *       console.log(`- ${dtc}`); // e.g., "P0300", "P0171"
 *     });
 *   }
 * } else {
 *   console.error("Failed to retrieve DTCs");
 * }
 * ```
 */
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
   * Retrieves current (active) DTCs from the vehicle in raw format
   *
   * This method sends the OBD Mode 03 request to retrieve currently active DTCs
   * that have triggered the Malfunction Indicator Light (MIL). It:
   *
   * 1. Configures the adapter appropriately for DTC retrieval
   * 2. Sends the Mode 03 command to request current DTCs
   * 3. Processes and validates the raw response data
   * 4. Handles protocol-specific message formatting
   * 5. Implements error handling and automatic retries
   *
   * Note: This method overrides the base class implementation to add
   * specific logging relevant to current DTCs, but relies on the base
   * class for the core retrieval logic.
   *
   * @returns Promise resolving to a RawDTCResponse object containing the
   *          structured raw data, or null if retrieval failed
   *
   * @example
   * ```typescript
   * // Get raw DTC response data
   * const rawResponse = await dtcRetriever.retrieveRawDTCs();
   *
   * if (rawResponse) {
   *   console.log(`Response received from ECU: ${rawResponse.ecuAddress}`);
   *   console.log(`Using protocol: ${rawResponse.protocolNumber}`);
   *
   *   // Raw response can be parsed into DTCs using parseDTCs method
   * }
   * ```
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
