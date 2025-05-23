import { ECUConnectionStatus } from '../utils/constants'; // Import PROTOCOL if needed
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
 *
 * 6. ECU Detection State:
 *    - ecuDetectionState: Tracks the multi-step process of detecting ECUs and protocols.
 */
export const initialState: ECUState = {
  status: ECUConnectionStatus.DISCONNECTED,
  activeProtocol: null,
  protocolName: null,
  voltage: null,
  deviceVoltage: null,
  lastError: null,
  currentDTCs: [],
  pendingDTCs: [],
  rawCurrentDTCs: null,
  rawPendingDTCs: null,
  rawPermanentDTCs: null,
  dtcLoading: false,
  dtcClearing: false,
  rawDTCLoading: false,
  initializationState: {
    initAttempts: 0,
    maxInitAttempts: 3,
  },
  ecuDetectionState: {
    inProgress: false,
    searchAttempts: 0,
    maxSearchAttempts: 3,
  },
};

export const ecuReducer = (state: ECUState, action: ECUAction): ECUState => {
  switch (action.type) {
    case ECUActionType.CONNECT_START: {
      return {
        ...initialState,
        status: ECUConnectionStatus.CONNECTING,
        initializationState: {
          ...initialState.initializationState,
          initAttempts: 0,
        },
        ecuDetectionState: {
          ...initialState.ecuDetectionState,
          maxSearchAttempts: state.ecuDetectionState.maxSearchAttempts,
          inProgress: true,
          lastAttemptTime: Date.now(),
          currentStep: 'INIT',
        },
      };
    }

    case ECUActionType.CONNECT_SUCCESS: {
      const ecuAddresses = action.payload?.detectedEcuAddresses ?? [];

      return {
        ...state,
        status: ECUConnectionStatus.CONNECTED,
        activeProtocol: action.payload?.protocol ?? null,
        protocolName: action.payload?.protocolName ?? null,
        deviceVoltage: action.payload?.voltage ?? state.deviceVoltage,
        detectedEcuAddresses: ecuAddresses,
        selectedEcuAddress: ecuAddresses[0] ?? null, // Set first ECU as selected
        lastError: null,
        ecuDetectionState: {
          ...initialState.ecuDetectionState,
          maxSearchAttempts: state.ecuDetectionState.maxSearchAttempts,
          inProgress: false,
          currentStep: 'COMPLETE',
          lastAttemptTime: Date.now(),
        },
      };
    }

    case ECUActionType.CONNECT_FAILURE: {
      const errorMsg = action.payload?.error ?? 'Unknown connection error';
      const command = action.payload?.initCommand;

      // Handle initialization failures specifically
      if (command && ['ATZ', 'ATRV'].includes(command)) {
        const attempts = state.initializationState.initAttempts + 1;
        if (attempts < state.initializationState.maxInitAttempts) {
          return {
            ...state,
            status: ECUConnectionStatus.CONNECTING,
            lastError: `Init command ${command} failed (attempt ${attempts})`,
            initializationState: {
              ...state.initializationState,
              initAttempts: attempts,
              lastInitCommand: command,
            },
          };
        }
      }

      // Check if we are still in the detection process
      if (state.ecuDetectionState.inProgress) {
        const attempts = state.ecuDetectionState.searchAttempts + 1;
        // Check if we can retry within the max attempts limit
        if (attempts < state.ecuDetectionState.maxSearchAttempts) {
          // Update state for retry: increment attempts, keep status CONNECTING
          return {
            ...state,
            status: ECUConnectionStatus.CONNECTING, // Keep trying
            lastError: `ECU detection attempt ${attempts} failed: ${errorMsg}`,
            ecuDetectionState: {
              ...state.ecuDetectionState,
              searchAttempts: attempts,
              lastAttemptTime: Date.now(),
              currentStep: 'RETRY', // Indicate retry needed
              // Optionally clear last command/response here if needed
              // lastCommand: null,
              // lastResponse: null,
            },
          };
        } else {
          // Max attempts reached, transition to final failure state
          return {
            ...initialState, // Reset most state
            status: ECUConnectionStatus.CONNECTION_FAILED,
            lastError: `Connection failed after ${attempts} attempts: ${errorMsg}`,
            ecuDetectionState: {
              ...initialState.ecuDetectionState, // Reset detection state fully
              maxSearchAttempts: state.ecuDetectionState.maxSearchAttempts, // Keep config
            },
          };
        }
      } else {
        // If not in detection phase, it's a general connection failure outside the initial process
        return {
          ...initialState, // Reset fully on failure
          status: ECUConnectionStatus.CONNECTION_FAILED,
          lastError: errorMsg, // Keep last error message
          ecuDetectionState: {
            ...initialState.ecuDetectionState, // Reset detection state
            maxSearchAttempts: state.ecuDetectionState.maxSearchAttempts, // Keep config
          },
        };
      }
    }
    case ECUActionType.DISCONNECT:
      // Reset to initial state, perhaps keeping voltage for informational purposes?
      return {
        ...initialState,
        deviceVoltage: state.deviceVoltage, // Option: Keep last known voltage on disconnect
        ecuDetectionState: {
          ...initialState.ecuDetectionState, // Reset detection state
          maxSearchAttempts: state.ecuDetectionState.maxSearchAttempts, // Keep config
        },
      };
    case ECUActionType.SET_ECU_INFO:
      // Update specific info like voltage without changing connection status
      return {
        ...state,
        // Use nullish coalescing for voltage update
        deviceVoltage: action.payload?.voltage ?? state.deviceVoltage,
        // Can add other info updates here if needed
      };
    case ECUActionType.RESET: {
      return {
        ...initialState,
        currentDTCs: [],
        pendingDTCs: [],
        // Keep other state parts intact or reset as necessary
        ecuDetectionState: {
          ...initialState.ecuDetectionState,
          maxSearchAttempts: state.ecuDetectionState.maxSearchAttempts,
        },
      };
    }

    // --- DTC related actions remain unchanged (as per requirement) ---
    case ECUActionType.FETCH_DTCS_START:
      return {
        ...state,
        dtcLoading: true,
        currentDTCs: [],
        pendingDTCs: [],
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
      return {
        ...state,
        dtcClearing: false,
        currentDTCs: [],
        pendingDTCs: [],
        rawCurrentDTCs: null,
        rawPendingDTCs: null,
        rawPermanentDTCs: null,
        lastError: null,
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
        rawCurrentDTCs: action.payload?.data || null,
      };
    case ECUActionType.FETCH_RAW_PENDING_DTCS_SUCCESS:
      return {
        ...state,
        rawDTCLoading: false,
        rawPendingDTCs: action.payload?.data || null,
      };
    case ECUActionType.FETCH_RAW_PERMANENT_DTCS_SUCCESS:
      return {
        ...state,
        rawDTCLoading: false,
        rawPermanentDTCs: action.payload?.data || null,
      };
    case ECUActionType.FETCH_RAW_DTCS_FAILURE:
      return {
        ...state,
        rawDTCLoading: false,
        lastError: action.payload?.error ?? 'Failed to fetch raw DTCs',
      };

    case ECUActionType.SYNC_STATE:
      // Sync entire state from context
      return action.payload as ECUState;

    case ECUActionType.BLUETOOTH_STATE_CHANGE:
      if (action.payload?.bluetoothState === 'off') {
        return {
          ...initialState,
          status: ECUConnectionStatus.DISCONNECTED,
          lastError: 'Bluetooth turned off',
        };
      }
      return state;

    case ECUActionType.DEVICE_STATE_CHANGE:
      if (!action.payload?.device?.connected) {
        return {
          ...initialState,
          status: ECUConnectionStatus.DISCONNECTED,
          lastError: 'Device disconnected',
        };
      }
      return state;

    default:
      return state;
  }
};
