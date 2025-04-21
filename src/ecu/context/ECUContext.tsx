import React, {
  createContext,
  useReducer,
  useCallback,
  useMemo,
  type ReactNode,
  type FC,
} from 'react';
import { useBluetooth } from 'react-native-bluetooth-obd-manager';

import { log } from '../../utils/logger';
// Import connectionService functions
import {
  connectToECU,
  getAdapterInfo,
  disconnectFromECU,
  // Non-ECU functions (keep imports for existing calls, implementations unchanged)
  getVehicleVIN,
  clearVehicleDTCs,
  getRawDTCs, // Used by Raw DTC wrappers below
} from '../services/connectionService';
import {
  OBD_MODE,
  ECUConnectionStatus,
  type PROTOCOL,
} from '../utils/constants';
import { ECUActionType } from '../utils/types';

import { initialState, ecuReducer } from './ECUReducer';

import type {
  ECUContextValue,
  RawDTCResponse,
  SendCommandFunction,
  ECUActionPayload,
} from '../utils/types';

/**
 * React Context for ECU communication
 *
 * This context provides access to all ECU-related functionality including:
 * - Connection management (connect/disconnect)
 * - State information (connection status, protocol, voltage)
 * - Vehicle data retrieval (VIN, DTCs)
 * - Raw command execution
 *
 * @example
 * ```tsx
 * // Consuming the context directly (usually prefer useECU hook instead)
 * function VehicleStatus() {
 *   return (
 *     <ECUContext.Consumer>
 *       {(ecuContext) => {
 *         if (!ecuContext) return <Text>No ECU context available</Text>;
 *
 *         const { state } = ecuContext;
 *         return (
 *           <View>
 *             <Text>Status: {state.status}</Text>
 *             <Text>Protocol: {state.protocolName || 'Unknown'}</Text>
 *             <Text>Voltage: {state.deviceVoltage || 'Unknown'}</Text>
 *           </View>
 *         );
 *       }}
 *     </ECUContext.Consumer>
 *   );
 * }
 * ```
 */
export const ECUContext = createContext<ECUContextValue | null>(null);

/**
 * Props for the ECUProvider component
 */
interface ECUProviderProps {
  /** React children components */
  children: ReactNode;
}

/**
 * Provider component for ECU communication
 *
 * This component creates the ECU context and provides all ECU-related
 * functionality to its children components. It manages the ECU connection
 * state and provides methods for interacting with the vehicle's ECU.
 *
 * Must be placed within a BluetoothProvider from react-native-bluetooth-obd-manager.
 *
 * @example
 * ```tsx
 * import { ECUProvider } from 'react-native-obd-retriver';
 * import { BluetoothProvider } from 'react-native-bluetooth-obd-manager';
 *
 * function App() {
 *   return (
 *     <BluetoothProvider>
 *       <ECUProvider>
 *         <VehicleMonitor />
 *       </ECUProvider>
 *     </BluetoothProvider>
 *   );
 * }
 * ```
 */
export const ECUProvider: FC<ECUProviderProps> = ({ children }) => {
  const [state, dispatch] = useReducer(ecuReducer, initialState);
  const {
    sendCommand: bluetoothSendCommand, // Rename to avoid conflict
    connectedDevice,
    // error: bluetoothError, // Get BT level error if needed
    // isConnecting: isBluetoothConnecting, // Get BT level connecting status
  } = useBluetooth();

  // Determine connection status based on connectedDevice (Bluetooth level)
  const isBluetoothConnected = !!connectedDevice;

  // --- Core Send Command Wrapper ---
  // This function is passed down to services and hooks
  const sendCommand = useCallback<SendCommandFunction>(
    async (
      command: string,
      timeout?: number | { timeout?: number },
    ): Promise<string | null> => {
      // Check Bluetooth connection status before sending
      if (!isBluetoothConnected || !bluetoothSendCommand) {
        await log.warn(
          '[ECUContext] Attempted to send command while Bluetooth disconnected or command function unavailable:',
          { command },
        );
        // Return null to indicate failure as per SendCommandFunction type
        return null;
      }
      try {
        await log.debug(
          `[ECUContext] Sending command via BT hook: ${command}`,
          { timeout },
        );
        // Pass timeout if provided
        // react-native-bluetooth-obd-manager sendCommand might need an options object
        const response = await bluetoothSendCommand(
          command,
          // Adapt timeout format for the library
          typeof timeout === 'number' ? { timeout } : timeout,
        );
        await log.debug(
          `[ECUContext] Received response for "${command}": ${response ?? 'null'}`,
        );
        // Ensure return type matches SendCommandFunction (Promise<string | null>)
        // The hook likely returns string | null already.
        return response;
      } catch (error: unknown) {
        // Log and handle errors, return null on failure
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        await log.error(
          `[ECUContext] Error sending command "${command}" via BT hook:`,
          {
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
          },
        );
        // Consider specific error types if needed (e.g., BleError from the hook)
        // Return null to indicate failure according to SendCommandFunction type
        return null;
      }
    },
    [isBluetoothConnected, bluetoothSendCommand], // Dependencies: BT connection status and the BT send function
  );

  // --- Core ECU Connection Logic ---
  const connectWithECU = useCallback(async (): Promise<boolean> => {
    await log.debug('[ECUContext] Starting ECU connection process');
    // Update state to connecting first
    dispatch({ type: ECUActionType.CONNECT_START });
    // Add small delay to ensure state is updated
    await new Promise(resolve => setTimeout(resolve, 0));

    // Ensure Bluetooth is connected first
    if (!isBluetoothConnected) {
      const errorMsg = 'Bluetooth device not connected. Please connect via Bluetooth first.';
      await log.error(`[ECUContext] Connection failed: ${errorMsg}`);
      dispatch({
        type: ECUActionType.CONNECT_FAILURE,
        payload: { error: errorMsg },
      });
      return false;
    }

    try {
      // Call the connection service function which handles init, protocol detect, etc.
      const result = await connectToECU(sendCommand);

      if (result.success) {
        const payload: ECUActionPayload = {
          protocol: result.protocol ?? null,
          protocolName: result.protocolName ?? null,
          voltage: parseVoltage(result.voltage),
          detectedEcuAddresses: result.detectedEcus ?? [],
        };
        
        // Update state and wait for next tick
        dispatch({ type: ECUActionType.CONNECT_SUCCESS, payload });
        await new Promise(resolve => setTimeout(resolve, 0));
        
        // Now log after state is updated
        await log.info(
          `[ECUContext] ECU Connection successful. Protocol: ${result.protocolName ?? 'Unknown'} (${result.protocol ?? 'N/A'})`
        );
        return true;
      } else {
        const errorMsg = result.error ?? 'ECU connection process failed.';
        // Update state and wait for next tick
        dispatch({
          type: ECUActionType.CONNECT_FAILURE,
          payload: { error: errorMsg },
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        
        await log.error(`[ECUContext] ECU Connection failed: ${errorMsg}`);
        return false;
      }
    } catch (error: unknown) {
      let errorMsg: string;
      if (error instanceof Error) {
        errorMsg = `ECU Connection exception: ${error.message}`;
      } else {
        errorMsg = `ECU Connection exception: ${String(error)}`;
      }
      
      // Update state and wait for next tick
      dispatch({
        type: ECUActionType.CONNECT_FAILURE,
        payload: { error: errorMsg },
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      
      await log.error('[ECUContext] Connection exception details:', {
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return false;
    }
  }, [sendCommand, isBluetoothConnected]); // Depends on our sendCommand wrapper -> which depends on BT status

  // --- Core ECU Disconnect Logic ---
  const disconnectECU = useCallback(async (): Promise<void> => {
    await log.info('[ECUContext] disconnectECU called');
    // Check internal ECU connection status first
    if (
      state.status === ECUConnectionStatus.CONNECTED ||
      state.status === ECUConnectionStatus.CONNECTING
    ) {
      try {
        // Send ECU protocol close command via the service
        await disconnectFromECU(sendCommand);
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        await log.warn(
          '[ECUContext] Error during ECU service disconnect (ATPC):',
          { error: errorMsg },
        );
        // Continue with disconnect flow even if ATPC fails
      } finally {
        // Reset internal ECU state regardless of ATPC success
        dispatch({ type: ECUActionType.DISCONNECT });
        await log.info(
          '[ECUContext] Internal ECU state reset to DISCONNECTED.',
        );
        // Important: Let the calling component handle Bluetooth disconnect if necessary.
        // This hook manages ECU state, not the underlying BT connection.
      }
    } else {
      await log.debug(
        '[ECUContext] Already disconnected (ECU state). No action needed.',
      );
    }
  }, [sendCommand, state.status]); // Depends on sendCommand and ECU state

  // --- Information Retrieval ---
  const getECUInformation = useCallback(async (): Promise<void> => {
    // Check ECU connection status from our state
    if (state.status !== ECUConnectionStatus.CONNECTED) {
      await log.warn('[ECUContext] Cannot get ECU info: Not connected to ECU.');
      return;
    }
    try {
      await log.debug('[ECUContext] Attempting to get adapter info...');
      // Call the service function to get adapter info
      const info = await getAdapterInfo(sendCommand);

      // Check if voltage info was successfully retrieved
      if (info.voltage === null || info.voltage === undefined) {
        await log.warn('[ECUContext] Voltage information not retrieved from adapter info.');
      }

      // Dispatch action to update state with retrieved info (voltage)
      // Ensure payload properties match ECUActionPayload interface
      const payload: ECUActionPayload = { 
        voltage: parseVoltage(info.voltage)
      }; // Ensure voltage is string | null
      dispatch({ type: ECUActionType.SET_ECU_INFO, payload });
      await log.debug('[ECUContext] ECU information updated.', {
        voltage: info.voltage,
      });
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.error('[ECUContext] Failed to get ECU information:', {
        error: errorMsg,
      });
    }
  }, [sendCommand, state.status]); // Depends on sendCommand and ECU state

  // --- Get Active Protocol ---
  const getActiveProtocol = useCallback((): {
    protocol: PROTOCOL | null;
    name: string | null;
  } => {
    // Directly return from state
    return {
      protocol: state.activeProtocol,
      name: state.protocolName,
    };
  }, [state.activeProtocol, state.protocolName]); // Depends only on state

  // --- Non-ECU Function Wrappers (Keep as is, ensure they use sendCommand) ---
  // --- These call the unchanged functions in connectionService ---

  const getVIN = useCallback(async (): Promise<string | null> => {
    log.debug(JSON.stringify(state.status));
    if (state.status !== ECUConnectionStatus.CONNECTED) {
      await log.warn('[ECUContext] Cannot get VIN: Not connected to ECU.');
      return null;
    }
    try {
      // Call the unmodified service function
      return await getVehicleVIN(sendCommand);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.error('[ECUContext] Failed to get VIN:', { error: errorMsg });
      return null;
    }
  }, [sendCommand, state.status]);

  const clearDTCs = useCallback(
    async (skipVerification: boolean = false): Promise<boolean> => {
      if (state.status !== ECUConnectionStatus.CONNECTED) {
        await log.warn('[ECUContext] Cannot clear DTCs: Not connected to ECU.');
        return false;
      }
      dispatch({ type: ECUActionType.CLEAR_DTCS_START });
      try {
        // Call the unmodified service function
        const success = await clearVehicleDTCs(sendCommand, skipVerification);
        if (success) {
          dispatch({ type: ECUActionType.CLEAR_DTCS_SUCCESS });
        } else {
          // Service function handles logging failure, just update state
          dispatch({
            type: ECUActionType.CLEAR_DTCS_FAILURE,
            payload: { error: 'Failed to clear DTCs (reported by service)' },
          });
        }
        return success;
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        dispatch({
          type: ECUActionType.CLEAR_DTCS_FAILURE,
          payload: { error: `Clear DTCs exception: ${errorMsg}` },
        });
        await log.error('[ECUContext] Clear DTCs exception:', {
          error: errorMsg,
        });
        return false;
      }
    },
    [sendCommand, state.status],
  );

  // Wrappers for Raw DTC retrieval using the unmodified service function getRawDTCs
  const getRawCurrentDTCs =
    useCallback(async (): Promise<RawDTCResponse | null> => {
      if (state.status !== ECUConnectionStatus.CONNECTED) {
        await log.warn(
          '[ECUContext] Cannot get raw current DTCs: Not connected to ECU.',
        );
        return null;
      }
      dispatch({ type: ECUActionType.FETCH_RAW_DTCS_START });
      try {
        const data = await getRawDTCs(sendCommand, OBD_MODE.CURRENT_DTC);
        const payload: ECUActionPayload = { data };
        dispatch({
          type: ECUActionType.FETCH_RAW_CURRENT_DTCS_SUCCESS,
          payload,
        });
        return data;
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        dispatch({
          type: ECUActionType.FETCH_RAW_DTCS_FAILURE,
          payload: { error: `Failed to get raw current DTCs: ${errorMsg}` },
        });
        await log.error('[ECUContext] Get raw current DTCs exception:', {
          error: errorMsg,
        });
        return null;
      }
    }, [sendCommand, state.status]);

  const getRawPendingDTCs =
    useCallback(async (): Promise<RawDTCResponse | null> => {
      if (state.status !== ECUConnectionStatus.CONNECTED) {
        await log.warn(
          '[ECUContext] Cannot get raw pending DTCs: Not connected to ECU.',
        );
        return null;
      }
      dispatch({ type: ECUActionType.FETCH_RAW_DTCS_START });
      try {
        const data = await getRawDTCs(sendCommand, OBD_MODE.PENDING_DTC);
        const payload: ECUActionPayload = { data };
        dispatch({
          type: ECUActionType.FETCH_RAW_PENDING_DTCS_SUCCESS,
          payload,
        });
        return data;
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        dispatch({
          type: ECUActionType.FETCH_RAW_DTCS_FAILURE,
          payload: { error: `Failed to get raw pending DTCs: ${errorMsg}` },
        });
        await log.error('[ECUContext] Get raw pending DTCs exception:', {
          error: errorMsg,
        });
        return null;
      }
    }, [sendCommand, state.status]);

  const getRawPermanentDTCs =
    useCallback(async (): Promise<RawDTCResponse | null> => {
      if (state.status !== ECUConnectionStatus.CONNECTED) {
        await log.warn(
          '[ECUContext] Cannot get raw permanent DTCs: Not connected to ECU.',
        );
        return null;
      }
      dispatch({ type: ECUActionType.FETCH_RAW_DTCS_START });
      try {
        const data = await getRawDTCs(sendCommand, OBD_MODE.PERMANENT_DTC);
        const payload: ECUActionPayload = { data };
        dispatch({
          type: ECUActionType.FETCH_RAW_PERMANENT_DTCS_SUCCESS,
          payload,
        });
        return data;
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        dispatch({
          type: ECUActionType.FETCH_RAW_DTCS_FAILURE,
          payload: { error: `Failed to get raw permanent DTCs: ${errorMsg}` },
        });
        await log.error('[ECUContext] Get raw permanent DTCs exception:', {
          error: errorMsg,
        });
        return null;
      }
    }, [sendCommand, state.status]);

  // Memoize the context value
  const contextValue = useMemo<ECUContextValue>(
    () => ({
      state,
      connectWithECU, // Updated function
      disconnectECU, // Updated function
      getECUInformation, // Updated function
      getActiveProtocol, // Updated function
      // Keep non-ECU functions pointing to their wrappers
      getVIN,
      clearDTCs,
      getRawCurrentDTCs,
      getRawPendingDTCs,
      getRawPermanentDTCs,
      sendCommand, // Provide the wrapped sendCommand
    }),
    [
      // Ensure all dependencies are listed correctly
      state,
      connectWithECU,
      disconnectECU,
      getECUInformation,
      getActiveProtocol,
      getVIN,
      clearDTCs,
      getRawCurrentDTCs,
      getRawPendingDTCs,
      getRawPermanentDTCs,
      sendCommand, // Include sendCommand in dependency array
    ],
  );

  return (
    <ECUContext.Provider value={contextValue}>{children}</ECUContext.Provider>
  );
};

// Move parseVoltage outside and before ECUProvider component
const parseVoltage = (voltageStr: string | null | undefined): number | null => {
  if (!voltageStr) return null;
  // Remove 'V' suffix and convert to number
  const numericValue = parseFloat(voltageStr.replace('V', ''));
  return isNaN(numericValue) ? null : numericValue;
};
