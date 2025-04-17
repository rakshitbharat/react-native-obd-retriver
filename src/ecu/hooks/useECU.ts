import { useContext } from 'react';

import { ECUContext } from '../context/ECUContext';

import type { ECUContextValue } from '../utils/types';

/**
 * Core hook for accessing ECU functionality in React components
 * 
 * This hook provides access to all ECU communication features, including:
 * - Connection management
 * - Protocol information
 * - Vehicle data retrieval (VIN, DTCs, etc.)
 * - Raw command execution
 * 
 * @example
 * ```tsx
 * import { useECU } from 'react-native-obd-retriver';
 * 
 * function VehicleMonitor() {
 *   const { 
 *     state, 
 *     connectWithECU, 
 *     disconnectECU,
 *     getVIN,
 *     getRawCurrentDTCs 
 *   } = useECU();
 *   
 *   const handleConnect = async () => {
 *     const success = await connectWithECU();
 *     if (success) {
 *       console.log("Connected to ECU!");
 *       console.log(`Protocol: ${state.protocolName}`);
 *       console.log(`Voltage: ${state.deviceVoltage}`);
 *     }
 *   };
 *   
 *   // Component rendering and other handlers...
 * }
 * ```
 * 
 * @returns All ECU functionality exposed by the ECUContext
 * @throws Error if used outside of an ECUProvider
 */
export const useECU = (): ECUContextValue => {
  const context = useContext(ECUContext);

  if (!context) {
    throw new Error('useECU must be used within an ECUProvider');
  }

  return context;
};
