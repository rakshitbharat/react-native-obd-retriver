/**
 * React Native OBD Retriever library - Main Entry Point
 *
 * This library provides a comprehensive solution for OBD-II communication
 * in React Native applications, with support for Bluetooth adapters and
 * standardized vehicle diagnostic protocols.
 *
 * Main Components:
 *
 * 1. React Integration:
 *    - ECUProvider: Context provider that manages OBD communication state
 *    - useECU: React hook for accessing all ECU functionality
 *    - useDTCRetriever: Specialized hook for diagnostic trouble codes
 *
 * 2. Diagnostic Features:
 *    - DTC retrieval: Current, pending, and permanent trouble codes
 *    - VIN retrieval: Vehicle identification number
 *    - Protocol detection: Automatic OBD protocol handling
 *
 * @example Basic Setup
 * ```tsx
 * import React from 'react';
 * import { View, Text, Button } from 'react-native';
 * import { ECUProvider, useECU } from 'react-native-obd-retriver';
 *
 * export function App() {
 *   return (
 *     <ECUProvider>
 *       <VehicleDiagnostics />
 *     </ECUProvider>
 *   );
 * }
 *
 * function VehicleDiagnostics() {
 *   const { state, connectWithECU, disconnectECU, getRawCurrentDTCs } = useECU();
 *
 *   // Now you can access all ECU functionality
 * }
 * ```
 */

// React Hooks and Components
export { useECU } from './ecu/hooks/useECU';
export { ECUProvider } from './ecu/context/ECUContext';
// Export types from retrievers namespace
export * as retrievers from './ecu/retrievers';
// Export types from utils namespace
export * as utils from './ecu/utils/types';
export * from './utils/colors';
