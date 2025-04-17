import { useCallback } from 'react';

import {
  CurrentDTCRetriever,
  PendingDTCRetriever,
  PermanentDTCRetriever,
  type RawDTCResponse,
} from '../retrievers';

import { useECU } from './useECU';

/**
 * Hook for retrieving Diagnostic Trouble Codes (DTCs) from vehicle's ECU
 * 
 * This hook provides methods to retrieve raw DTC data from the vehicle using
 * different OBD-II service modes. It directly interfaces with the specific
 * DTC retrievers to get diagnostic information.
 * 
 * The hook provides three methods corresponding to different service modes:
 * - `get03DTCObject`: Retrieve current/active DTCs (Mode 03)
 * - `get07DTCObject`: Retrieve pending DTCs (Mode 07)
 * - `get0ADTCObject`: Retrieve permanent DTCs (Mode 0A)
 * 
 * @example
 * ```tsx
 * function DiagnosticsComponent() {
 *   const { get03DTCObject, get07DTCObject, get0ADTCObject } = useDTCRetriever();
 *   const [currentDTCs, setCurrentDTCs] = useState<RawDTCResponse | null>(null);
 *   
 *   const fetchCurrentDTCs = async () => {
 *     try {
 *       const dtcs = await get03DTCObject();
 *       setCurrentDTCs(dtcs);
 *       
 *       if (dtcs && dtcs.troubleCodes.length > 0) {
 *         console.log('Found trouble codes:', dtcs.troubleCodes);
 *       } else {
 *         console.log('No active DTCs found');
 *       }
 *     } catch (error) {
 *       console.error('Error retrieving DTCs:', error);
 *     }
 *   };
 *   
 *   return (
 *     <View>
 *       <Button title="Get Current DTCs" onPress={fetchCurrentDTCs} />
 *     </View>
 *   );
 * }
 * ```
 * 
 * @returns Object containing methods to retrieve different types of DTCs
 */
export const useDTCRetriever = (): {
  /**
   * Retrieves current/active DTCs (Mode 03)
   * @returns Promise resolving to raw DTC response or null if retrieval failed
   */
  get03DTCObject: () => Promise<RawDTCResponse | null>;
  
  /**
   * Retrieves pending DTCs (Mode 07)
   * @returns Promise resolving to raw DTC response or null if retrieval failed
   */
  get07DTCObject: () => Promise<RawDTCResponse | null>;
  
  /**
   * Retrieves permanent DTCs (Mode 0A)
   * @returns Promise resolving to raw DTC response or null if retrieval failed
   */
  get0ADTCObject: () => Promise<RawDTCResponse | null>;
} => {
  const { sendCommand } = useECU();

  const get03DTCObject = useCallback(async () => {
    const retriever = new CurrentDTCRetriever(sendCommand);
    return await retriever.retrieveRawDTCs();
  }, [sendCommand]);

  const get07DTCObject = useCallback(async () => {
    const retriever = new PendingDTCRetriever(sendCommand);
    return await retriever.retrieveRawDTCs();
  }, [sendCommand]);

  const get0ADTCObject = useCallback(async () => {
    const retriever = new PermanentDTCRetriever(sendCommand);
    return await retriever.retrieveRawDTCs();
  }, [sendCommand]);

  return {
    get03DTCObject,
    get07DTCObject,
    get0ADTCObject,
  };
};
