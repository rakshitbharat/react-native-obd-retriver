import { log } from '../../utils/logger';
import { ECUConnectionStatus } from '../utils/constants';
import { ECUActionType } from '../utils/types';

import type { ECUAction, ECUState } from '../utils/types';

/**
 * Initial state for the ECU context reducer
 * 
 * This state object represents the complete state of the ECU communication system,
 * including connection status, protocol information, and diagnostic data.
 * 
 * The state is organized into several logical groups:
 * 
 * 1. Connection state:
 *    - status: Current connection status (DISCONNECTED, CONNECTING, etc.)
 *    - lastError: Most recent error message, if any
 * 
 * 2. Protocol information:
 *    - activeProtocol: Numeric protocol ID detected by the adapter
 *    - protocolName: Human-readable name of the active protocol
 * 
 * 3. ECU information:
 *    - deviceVoltage: Current voltage reported by the OBD adapter
 *    - detectedEcuAddresses: Array of ECU addresses found on the vehicle's network
 *    - selectedEcuAddress: Currently selected ECU for targeted commands
 * 
 * 4. Diagnostic Trouble Code (DTC) states:
 *    - currentDTCs: Active DTCs that have triggered the Check Engine Light
 *    - pendingDTCs: Developing/intermittent DTCs that haven't triggered the MIL
 *    - permanentDTCs: Non-erasable DTCs for emissions compliance tracking
 *    - rawDTC* variants: Raw response data for each DTC type
 * 
 * 5. Operation states:
 *    - dtcLoading: Whether DTCs are currently being retrieved
 *    - dtcClearing: Whether a DTC clear operation is in progress
 *    - rawDTCLoading: Whether raw DTC data is being retrieved
 */
export const initialState: ECUState = {
  status: ECUConnectionStatus.DISCONNECTED,
  activeProtocol: null,
  protocolName: null, // Added
  lastError: null,
  deviceVoltage: null,
  detectedEcuAddresses: [], // Added
  selectedEcuAddress: null, // Added
  // DTC related state remains unchanged
  currentDTCs: null,
  pendingDTCs: null,
  permanentDTCs: null,
  dtcLoading: false,
  dtcClearing: false,
  rawCurrentDTCs: null,
  rawPendingDTCs: null,
  rawPermanentDTCs: null,
  rawDTCLoading: false,
};

/**
 * Reducer for ECU state management
 * 
 * This reducer handles all state transitions for the ECU communication system,
 * processing various actions related to connection management, DTC operations,
 * and vehicle information retrieval.
 * 
 * The reducer maintains immutability by creating new state objects for each action,
 * and implements careful error handling to ensure the application remains in a 
 * consistent state even when operations fail.
 * 
 * Action categories:
 * 
 * 1. Connection actions:
 *    - CONNECT_START: Initiates ECU connection process
 *    - CONNECT_SUCCESS: Updates state with protocol and ECU information
 *    - CONNECT_FAILURE: Records connection errors
 *    - DISCONNECT: Resets state after disconnection
 * 
 * 2. Information actions:
 *    - SET_ECU_INFO: Updates ECU metadata (voltage, etc.)
 *    - RESET: Performs complete state reset
 * 
 * 3. DTC operations:
 *    - FETCH_DTCS_*: Manages parsed DTC retrieval state
 *    - CLEAR_DTCS_*: Handles DTC clearing operations
 *    - FETCH_RAW_DTCS_*: Manages raw DTC data retrieval
 * 
 * Each action typically includes appropriate payload data that's carefully
 * extracted using nullish coalescing to ensure type safety and prevent runtime errors.
 * 
 * @param state - Current ECU state
 * @param action - Action to process with optional payload
 * @returns New ECU state
 */
export const ecuReducer = (state: ECUState, action: ECUAction): ECUState => {
  // Use void operator to mark promise as intentionally not awaited
  void log.debug(`[ECUReducer] Action: ${action.type}`, {
    payload: action.payload,
  });

  switch (action.type) {
    case ECUActionType.CONNECT_START:
      return {
        ...initialState, // Reset state on new connection attempt
        status: ECUConnectionStatus.CONNECTING,
        // Keep previous voltage if available? Or reset fully? Resetting is safer for consistency.
        // deviceVoltage: state.deviceVoltage, // Let's reset voltage too
      };
    case ECUActionType.CONNECT_SUCCESS: {
      // Extract data from payload provided by ECUContext upon successful connection
      const protocol = action.payload?.protocol ?? null; // Default to null if undefined
      const protocolName = action.payload?.protocolName ?? null; // Default to null
      const detectedEcus = action.payload?.detectedEcuAddresses ?? [];
      const voltage = action.payload?.voltage ?? null; // Use new voltage or null

      return {
        ...state, // Keep existing DTC/rawDTC state if any
        status: ECUConnectionStatus.CONNECTED,
        activeProtocol: protocol,
        protocolName: protocolName,
        // Select the first detected ECU as default, or null if none detected
        selectedEcuAddress: detectedEcus[0] ?? null,
        detectedEcuAddresses: detectedEcus,
        lastError: null, // Clear last error on success
        deviceVoltage: voltage, // Update voltage
      };
    }
    case ECUActionType.CONNECT_FAILURE:
      return {
        ...initialState, // Reset fully on failure
        status: ECUConnectionStatus.CONNECTION_FAILED,
        // Keep last error message
        lastError: action.payload?.error ?? 'Unknown connection error',
      };
    case ECUActionType.DISCONNECT:
      // Reset to initial state, perhaps keeping voltage for informational purposes?
      return {
        ...initialState,
        deviceVoltage: state.deviceVoltage, // Option: Keep last known voltage on disconnect
      };
    case ECUActionType.SET_ECU_INFO:
      // Update specific info like voltage without changing connection status
      return {
        ...state,
        // Use nullish coalescing for voltage update
        deviceVoltage: action.payload?.voltage ?? state.deviceVoltage,
        // Can add other info updates here if needed
      };
    case ECUActionType.RESET:
      // Full reset to initial state
      return initialState;

    // --- DTC related actions remain unchanged (as per requirement) ---
    case ECUActionType.FETCH_DTCS_START:
      // Assuming this action is still needed for non-raw DTCs handled elsewhere
      return {
        ...state,
        dtcLoading: true,
        currentDTCs: null,
        pendingDTCs: null,
        permanentDTCs: null,
      };
    case ECUActionType.FETCH_DTCS_SUCCESS:
      // Assuming this action is still needed
      return {
        ...state,
        dtcLoading: false,
        // Payload might contain parsed DTCs, handled by specific logic using this action
        currentDTCs: action.payload?.dtcs ?? state.currentDTCs, // Example update
      };
    case ECUActionType.FETCH_DTCS_FAILURE:
      // Assuming this action is still needed
      return {
        ...state,
        dtcLoading: false,
        lastError: action.payload?.error ?? 'Failed to fetch DTCs',
      };

    case ECUActionType.CLEAR_DTCS_START:
      return { ...state, dtcClearing: true };
    case ECUActionType.CLEAR_DTCS_SUCCESS:
      // Clear all DTC related states upon successful clear
      return {
        ...state,
        dtcClearing: false,
        currentDTCs: [], // Reset parsed DTCs
        pendingDTCs: [],
        permanentDTCs: [], // Clear permanent as well? Assuming Mode 04 might clear some types
        rawCurrentDTCs: null, // Reset raw DTC data
        rawPendingDTCs: null,
        rawPermanentDTCs: null,
        lastError: null, // Clear error on success
      };
    case ECUActionType.CLEAR_DTCS_FAILURE:
      return {
        ...state,
        dtcClearing: false,
        lastError: action.payload?.error ?? 'Failed to clear DTCs',
      };

    // --- Raw DTC actions remain unchanged (as per requirement) ---
    case ECUActionType.FETCH_RAW_DTCS_START:
      return { ...state, rawDTCLoading: true };
    case ECUActionType.FETCH_RAW_CURRENT_DTCS_SUCCESS:
      return {
        ...state,
        rawDTCLoading: false,
        rawCurrentDTCs: action.payload?.data ?? null,
      };
    case ECUActionType.FETCH_RAW_PENDING_DTCS_SUCCESS:
      return {
        ...state,
        rawDTCLoading: false,
        rawPendingDTCs: action.payload?.data ?? null,
      };
    case ECUActionType.FETCH_RAW_PERMANENT_DTCS_SUCCESS:
      return {
        ...state,
        rawDTCLoading: false,
        rawPermanentDTCs: action.payload?.data ?? null,
      };
    case ECUActionType.FETCH_RAW_DTCS_FAILURE:
      return {
        ...state,
        rawDTCLoading: false,
        lastError: action.payload?.error ?? 'Failed to fetch raw DTCs',
      };

    default:
      // Optional: Add exhaustive check for unhandled action types
      // const exhaustiveCheck: never = action; // Uncomment for exhaustive checks
      // If an unknown action type is received, log a warning and return current state
      void log.warn(
        `[ECUReducer] Received unknown action type: ${(action as ECUAction).type}`,
      );
      return state;
  }
};
