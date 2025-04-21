import React, { createContext, useMemo, type ReactNode } from 'react';
import { useBluetooth } from 'react-native-bluetooth-obd-manager';

import { log } from '../../utils/logger';
import {
  connectToECU,
  getAdapterInfo,
  getVehicleVIN,
  clearVehicleDTCs,
  getRawDTCs,
} from '../services/connectionService';
import {
  OBD_MODE,
  ECUConnectionStatus,
  type PROTOCOL,
} from '../utils/constants';
import { ECUActionType } from '../utils/types';

import type {
  ECUContextValue,
  RawDTCResponse,
  SendCommandFunction,
  ECUActionPayload,
  ECUState,
} from '../utils/types';
import { ecuStore, getState, dispatch, waitForStateUpdate } from './ECUStore';
import { initialState } from './ECUReducer';

// Add interface for provider props
interface ECUProviderProps {
  children: ReactNode;
}

// Create context with proper initial value
export const ECUContext = createContext<ECUContextValue>({
  state: initialState,
  connectWithECU: async () => false,
  disconnectECU: async () => {},
  clearDTCs: async () => false,
  getVIN: async () => null,
  getRawCurrentDTCs: async () => null,
  sendCommand: async () => null,
  getActiveProtocol: () => ({ protocol: null, name: null }),
  getECUInformation: async () => {},
  getRawPendingDTCs: async () => null,
  getRawPermanentDTCs: async () => null,
});

export const ECUProvider: React.FC<ECUProviderProps> = ({ children }) => {
  const { sendCommand: bluetoothSendCommand, connectedDevice } = useBluetooth();
  const isBluetoothConnected = !!connectedDevice;

  const sendCommand: SendCommandFunction = async (
    command: string,
    timeout?: number | { timeout?: number },
  ): Promise<string | null> => {
    if (!isBluetoothConnected || !bluetoothSendCommand) {
      await log.warn(
        '[ECUContext] Attempted to send command while Bluetooth disconnected or command function unavailable:',
        { command },
      );
      return null;
    }
    try {
      await log.debug(
        `[ECUContext] Sending command via BT hook: ${command}`,
        { timeout },
      );
      const response = await bluetoothSendCommand(
        command,
        typeof timeout === 'number' ? { timeout } : timeout,
      );
      await log.debug(
        `[ECUContext] Received response for "${command}": ${response ?? 'null'}`,
      );
      return response;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await log.error(
        `[ECUContext] Error sending command "${command}" via BT hook:`,
        {
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
      );
      return null;
    }
  };

  const connectWithECU = async (): Promise<boolean> => {
    try {
      dispatch({ type: ECUActionType.CONNECT_START });
      await log.info('[ECUContext] connectWithECU called');

      if (!isBluetoothConnected) {
        const errorMsg = 'Bluetooth device not connected. Please connect via Bluetooth first.';
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
          voltage: result.voltage ? parseFloat(result.voltage) : null,
          detectedEcuAddresses: result.detectedEcus ?? [],
        };

        dispatch({ type: ECUActionType.CONNECT_SUCCESS, payload });

        // Add type for state check function
        const stateUpdated = await waitForStateUpdate(
          (checkState: ECUState) => 
            checkState.status === ECUConnectionStatus.CONNECTED && 
            checkState.activeProtocol === result.protocol,
          2000
        );

        if (!stateUpdated) {
          await log.error('[ECUContext] State update timeout');
          return false;
        }

        await log.info(
          `[ECUContext] ECU Connection successful. Protocol: ${result.protocolName ?? 'Unknown'} (${result.protocol ?? 'N/A'})`,
        );

        return true;
      }

      const errorMsg = result.error ?? 'ECU connection process failed.';
      dispatch({
        type: ECUActionType.CONNECT_FAILURE,
        payload: { error: errorMsg },
      });
      await log.error(`[ECUContext] ECU Connection failed: ${errorMsg}`);
      return false;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      dispatch({
        type: ECUActionType.CONNECT_FAILURE,
        payload: { error: `ECU Connection exception: ${errorMsg}` },
      });
      await log.error('[ECUContext] Connection failed:', { error: errorMsg });
      return false;
    }
  };

  const getVIN = async (): Promise<string | null> => {
    const currentState = getState();
    
    if (currentState.status !== ECUConnectionStatus.CONNECTED) {
      await log.warn('[ECUContext] Cannot get VIN: ECU not connected', {
        state: currentState.status,
      });
      return null;
    }

    try {
      return await getVehicleVIN(sendCommand);
    } catch (error) {
      await log.error('[ECUContext] Error retrieving VIN:', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const clearDTCs = async (skipVerification: boolean = false): Promise<boolean> => {
    const currentState = getState();
    if (currentState.status !== ECUConnectionStatus.CONNECTED) {
      await log.warn('[ECUContext] Cannot clear DTCs: Not connected to ECU.');
      return false;
    }
    dispatch({ type: ECUActionType.CLEAR_DTCS_START });
    try {
      const success = await clearVehicleDTCs(sendCommand, skipVerification);
      if (success) {
        dispatch({ type: ECUActionType.CLEAR_DTCS_SUCCESS });
      } else {
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
  };

  const getRawCurrentDTCs = async (): Promise<RawDTCResponse | null> => {
    const currentState = getState();
    if (currentState.status !== ECUConnectionStatus.CONNECTED) {
      await log.warn('[ECUContext] Cannot get raw current DTCs: Not connected to ECU.');
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
  };

  const getRawPendingDTCs = async (): Promise<RawDTCResponse | null> => {
    const currentState = getState();
    if (currentState.status !== ECUConnectionStatus.CONNECTED) {
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
  };

  const getRawPermanentDTCs = async (): Promise<RawDTCResponse | null> => {
    const currentState = getState();
    if (currentState.status !== ECUConnectionStatus.CONNECTED) {
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
  };

  const getActiveProtocol = (): { protocol: PROTOCOL | null; name: string | null } => {
    const currentState = getState();
    return {
      protocol: currentState.activeProtocol,
      name: currentState.protocolName,
    };
  };

  const getECUInformation = async (): Promise<void> => {
    const currentState = getState();
    if (currentState.status !== ECUConnectionStatus.CONNECTED) {
      await log.warn('[ECUContext] Cannot get ECU info: Not connected to ECU.');
      return;
    }

    try {
      const adapterInfo = await getAdapterInfo(sendCommand);
      const vin = await getVehicleVIN(sendCommand);

      await log.info('[ECUContext] ECU Information retrieved', {
        adapterInfo,
        vin,
      });
    } catch (error) {
      await log.error('[ECUContext] Error retrieving ECU information:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Add disconnectECU function
  const disconnectECU = async (): Promise<void> => {
    const currentState = getState();
    if (currentState.status !== ECUConnectionStatus.CONNECTED) {
      return;
    }
    try {
      await sendCommand('ATPC'); // Send protocol close command
      dispatch({ type: ECUActionType.DISCONNECT });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await log.warn('[ECUContext] Error during disconnect:', { error: errorMsg });
    }
  };

  const contextValue = useMemo<ECUContextValue>(() => ({
    state: getState(),
    connectWithECU,
    disconnectECU, // Use the defined function
    clearDTCs,
    getVIN,
    getRawCurrentDTCs,
    sendCommand,
    getActiveProtocol,
    getECUInformation,
    getRawPendingDTCs,
    getRawPermanentDTCs,
  }), []); // Empty deps since we're using store directly

  return (
    <ECUContext.Provider value={contextValue}>{children}</ECUContext.Provider>
  );
};

export { ecuStore };

const parseVoltage = (voltageStr: string | null | undefined): number | null => {
  if (!voltageStr) return null;
  const numericValue = parseFloat(voltageStr.replace('V', ''));
  return isNaN(numericValue) ? null : numericValue;
};
