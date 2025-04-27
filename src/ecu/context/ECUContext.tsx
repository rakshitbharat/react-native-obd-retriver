import React, {
  createContext,
  useCallback,
  useMemo,
  useReducer,
  type ReactNode,
  type FC,
  useEffect,
} from 'react';
// Import the correct function name from the hook
import { useBluetooth } from 'react-native-bluetooth-obd-manager';
import { log } from '../../utils/logger';
import {
  connectToECU,
  getAdapterInfo,
  getVehicleVIN,
  clearVehicleDTCs,
  getRawDTCs,
} from '../services/connectionService';
import { OBD_MODE, ECUConnectionStatus } from '../utils/constants';
import { ECUActionType } from '../utils/types';

import { initialState, ecuReducer } from './ECUReducer';

import type {
  ECUContextValue,
  RawDTCResponse,
  SendCommandFunction,
  ChunkedResponse,
  BluetoothChunkedResponse,
  SendCommandRawFunction, // Keep this type alias for our internal function
  ECUActionPayload,
  ExtendedPeripheral,
} from '../utils/types';
import {
  ecuStore,
  getStore,
  waitForStateCondition,
  storeConditions,
} from './ECUStore';

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
    sendCommand: bluetoothSendCommand,
    // Import the function that returns the chunked response object
    sendCommandRawChunked: bluetoothSendCommandRawChunked,
    connectedDevice,
    error,
  } = useBluetooth();

  // Sync local state to store
  useEffect(() => {
    ecuStore.dispatch({
      type: ECUActionType.SYNC_STATE,
      payload: state,
    });
  }, [state]);

  // Track Bluetooth device changes
  useEffect(() => {
    if (connectedDevice) {
      const device = connectedDevice as ExtendedPeripheral;
      dispatch({
        type: ECUActionType.DEVICE_STATE_CHANGE,
        payload: {
          device: {
            connected: true,
            services: device.services?.map((s: { uuid: string }) => s.uuid),
            characteristics: device.characteristics?.map(
              (c: { service: string; characteristic: string }) => ({
                service: c.service,
                characteristic: c.characteristic,
              }),
            ),
          },
        },
      });
    } else {
      dispatch({
        type: ECUActionType.DEVICE_STATE_CHANGE,
        payload: {
          device: {
            connected: false,
          },
        },
      });
    }
  }, [connectedDevice, dispatch]);

  // Handle Bluetooth errors
  useEffect(() => {
    if (error) {
      dispatch({
        type: ECUActionType.CONNECT_FAILURE,
        payload: { error: error.message },
      });
    }
  }, [error, dispatch]);

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
        return response.toString(); // or response.data if that's the string property you need
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

  // --- Use the raw chunked send command if available ---
  // Keep our internal wrapper function named sendCommandRaw
  const sendCommandRaw = useCallback<SendCommandRawFunction>(
    async (
      command: string,
      timeout?: number | { timeout?: number },
    ): Promise<ChunkedResponse> => {
      // Check if the imported chunked function is available
      if (!isBluetoothConnected || !bluetoothSendCommandRawChunked) {
        await log.warn(
          '[ECUContext] Attempted to send raw command while Bluetooth disconnected or chunked function unavailable:',
          { command },
        );
        throw new Error(
          'Bluetooth not connected or chunked function unavailable',
        );
      }

      try {
        await log.debug(
          `[ECUContext] Sending raw chunked command via BT hook: ${command}`,
          { timeout },
        );

        // Call the imported chunked function from the hook
        const hookResponse: BluetoothChunkedResponse =
          await bluetoothSendCommandRawChunked(
            // Use the function from the hook
            command,
            typeof timeout === 'number' ? { timeout } : timeout,
          );

        // Validate the structure received from the hook (using local BluetoothChunkedResponse type)
        if (!hookResponse || !Array.isArray(hookResponse.chunks)) {
          await log.error(
            '[ECUContext] Invalid chunked response structure received from hook',
            { response: hookResponse },
          );
          throw new Error('Invalid chunked response received from hook');
        }

        // Calculate totalBytes from the received chunks
        const calculatedTotalBytes = hookResponse.chunks.reduce(
          (acc, chunk) => acc + chunk.length,
          0,
        );

        // Construct the response object matching the local ChunkedResponse type (with totalBytes)
        const response: ChunkedResponse = {
          // Type is the local ChunkedResponse
          chunks: hookResponse.chunks,
          command: command, // Use the command passed into the function
          totalBytes: calculatedTotalBytes, // Use calculated totalBytes
          rawResponse: hookResponse.rawResponse, // Copies the optional property
        };

        await log.debug(
          `[ECUContext] Received raw response for "${response.command}": ${response.chunks.length} chunks`,
          // Access totalBytes from the new object
          response,
        );

        // Return the newly constructed object which matches the local type definition
        return response;
      } catch (error: unknown) {
        // Log and handle errors, re-throw to reject the promise
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        await log.error(
          `[ECUContext] Error sending raw chunked command "${command}" via BT hook:`,
          {
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
          },
        );
        throw error;
      }
    },
    // Update dependency array to use the imported chunked function
    [isBluetoothConnected, bluetoothSendCommandRawChunked, log],
  );

  // --- Core ECU Connection Logic ---
  const connectWithECU = useCallback(async (): Promise<boolean> => {
    try {
      await log.debug('[ECUContext] Starting ECU connection process');
      dispatch({ type: ECUActionType.CONNECT_START });

      if (!isBluetoothConnected || !sendCommand) {
        const errorMsg =
          'Bluetooth device not connected. Please connect via Bluetooth first.';
        await log.error(`[ECUContext] Connection failed: ${errorMsg}`);
        dispatch({
          type: ECUActionType.CONNECT_FAILURE,
          payload: { error: errorMsg },
        });
        return false;
      }

      const result = await connectToECU(sendCommand);

      if (result.success) {
        const payload: ECUActionPayload = {
          protocol: result.protocol ?? null,
          protocolName: result.protocolName ?? null,
          voltage: parseVoltage(result.voltage),
          detectedEcuAddresses: result.detectedEcus ?? [],
        };

        dispatch({ type: ECUActionType.CONNECT_SUCCESS, payload });

        try {
          await waitForStateCondition(storeConditions.isConnectedWithECUs);
        } catch (timeoutError) {
          await log.warn(
            '[ECUContext] Store update timed out, but connection was successful',
            timeoutError,
          );
        }

        await log.info(
          `[ECUContext] ECU Connection successful. Protocol: ${result.protocolName ?? 'Unknown'} (${result.protocol ?? 'N/A'}), ECUs: ${payload.detectedEcuAddresses?.join(', ') ?? 'None'}`,
        );

        return true;
      } else {
        const errorMsg = result.error ?? 'ECU connection process failed.';
        dispatch({
          type: ECUActionType.CONNECT_FAILURE,
          payload: { error: errorMsg },
        });
        await log.error(`[ECUContext] ECU Connection failed: ${errorMsg}`);
        return false;
      }
    } catch (error: unknown) {
      const errorMsg =
        error instanceof Error
          ? `ECU Connection exception: ${error.message}`
          : `ECU Connection exception: ${String(error)}`;

      dispatch({
        type: ECUActionType.CONNECT_FAILURE,
        payload: { error: errorMsg },
      });

      await log.error('[ECUContext] Connection exception details:', {
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined,
      });

      return false;
    }
  }, [isBluetoothConnected, sendCommand, dispatch]);

  // --- Core ECU Disconnect Logic ---
  const disconnectFromECU = useCallback(async (): Promise<void> => {
    if (state.status !== ECUConnectionStatus.CONNECTED) {
      return;
    }
    try {
      await disconnectFromECU(); // Remove sendCommand parameter
      dispatch({ type: ECUActionType.DISCONNECT_SUCCESS });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.warn(
        '[ECUContext] Error during ECU service disconnect (ATPC):',
        { error: errorMsg },
      );
      // Continue with disconnect flow even if ATPC fails
    } finally {
      // Reset internal ECU state regardless of ATPC success
      dispatch({ type: ECUActionType.DISCONNECT });
      await log.info('[ECUContext] Internal ECU state reset to DISCONNECTED.');
      // Important: Let the calling component handle Bluetooth disconnect if necessary.
      // This hook manages ECU state, not the underlying BT connection.
    }
  }, [state.status, dispatch]); // Depends on sendCommand and ECU state

  // --- Information Retrieval ---
  const getECUInformation = useCallback(async (): Promise<void> => {
    const currentState = getStore();
    if (currentState.status !== ECUConnectionStatus.CONNECTED) {
      await log.warn('[ECUContext] Cannot get ECU info: Not connected to ECU.');
      return;
    }
    try {
      await log.debug('[ECUContext] Attempting to get adapter info...');
      // Call the service function to get adapter info
      const info = await getAdapterInfo(sendCommand);

      // Check if voltage info was successfully retrieved
      if (info.voltage === null || info.voltage === undefined) {
        await log.warn(
          '[ECUContext] Voltage information not retrieved from adapter info.',
        );
      }

      // Dispatch action to update state with retrieved info (voltage)
      // Ensure payload properties match ECUActionPayload interface
      const payload: ECUActionPayload = {
        voltage: parseVoltage(info.voltage),
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
  }, [sendCommand, dispatch]);

  // --- Get Active Protocol ---
  const getActiveProtocol = useCallback(() => {
    const currentState = getStore();
    return {
      protocol: currentState.activeProtocol,
      name: currentState.protocolName,
    };
  }, []);

  const getRawCurrentDTCs =
    useCallback(async (): Promise<RawDTCResponse | null> => {
      const currentState = getStore();
      if (currentState.status !== ECUConnectionStatus.CONNECTED) {
        await log.warn(
          '[ECUContext] Cannot get raw current DTCs: Not connected to ECU.',
        );
        return null;
      }
      try {
        return await getRawDTCs(sendCommand, OBD_MODE.CURRENT_DTC);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await log.error('[ECUContext] Failed to get raw current DTCs:', {
          error: errorMsg,
        });
        return null;
      }
    }, [sendCommand]);

  const getRawPendingDTCs =
    useCallback(async (): Promise<RawDTCResponse | null> => {
      const currentState = getStore();
      if (currentState.status !== ECUConnectionStatus.CONNECTED) {
        await log.warn(
          '[ECUContext] Cannot get raw pending DTCs: Not connected to ECU.',
        );
        return null;
      }
      try {
        return await getRawDTCs(sendCommand, OBD_MODE.PENDING_DTC);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await log.error('[ECUContext] Failed to get raw pending DTCs:', {
          error: errorMsg,
        });
        return null;
      }
    }, [sendCommand]);

  const getRawPermanentDTCs =
    useCallback(async (): Promise<RawDTCResponse | null> => {
      const currentState = getStore();
      if (currentState.status !== ECUConnectionStatus.CONNECTED) {
        await log.warn(
          '[ECUContext] Cannot get raw permanent DTCs: Not connected to ECU.',
        );
        return null;
      }
      try {
        return await getRawDTCs(sendCommand, OBD_MODE.PERMANENT_DTC);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await log.error('[ECUContext] Failed to get raw permanent DTCs:', {
          error: errorMsg,
        });
        return null;
      }
    }, [sendCommand]);

  const getVIN = useCallback(async (): Promise<string | null> => {
    const currentState = getStore();
    if (currentState.status !== ECUConnectionStatus.CONNECTED) {
      await log.warn('[ECUContext] Cannot get VIN: Not connected to ECU.');
      return null;
    }
    try {
      return await getVehicleVIN(sendCommand, sendCommandRaw);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.error('[ECUContext] Failed to get VIN:', { error: errorMsg });
      return null;
    }
  }, [sendCommand, sendCommandRaw]);

  // Add clearDTCs implementation
  const clearDTCs = useCallback(
    async (skipVerification = false): Promise<boolean> => {
      if (state.status !== ECUConnectionStatus.CONNECTED) {
        await log.warn('[ECUContext] Cannot clear DTCs: Not connected to ECU.');
        return false;
      }
      try {
        return await clearVehicleDTCs(sendCommand, skipVerification);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await log.error('[ECUContext] Failed to clear DTCs:', {
          error: errorMsg,
        });
        return false;
      }
    },
    [sendCommand, state.status],
  );

  // Update useMemo dependencies
  const contextValue = useMemo<ECUContextValue>(
    () => ({
      state,
      connectWithECU,
      disconnectECU: disconnectFromECU,
      clearDTCs,
      getVIN,
      getRawCurrentDTCs,
      getRawPendingDTCs,
      getRawPermanentDTCs,
      getECUInformation,
      getActiveProtocol,
      sendCommand,
      sendCommandWithResponse: sendCommand,
    }),
    [
      state,
      connectWithECU,
      disconnectFromECU,
      clearDTCs,
      getVIN,
      getRawCurrentDTCs,
      getRawPendingDTCs,
      getRawPermanentDTCs,
      getECUInformation,
      getActiveProtocol,
      sendCommand,
    ],
  );

  return (
    <ECUContext.Provider value={contextValue}>{children}</ECUContext.Provider>
  );
};

// Export store for direct access
export { ecuStore };

// Move parseVoltage outside and before ECUProvider component
const parseVoltage = (voltageStr: string | null | undefined): number | null => {
  if (!voltageStr) return null;
  // Remove 'V' suffix and convert to number
  const numericValue = parseFloat(voltageStr.replace('V', ''));
  return isNaN(numericValue) ? null : numericValue;
};
