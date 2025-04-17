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

// React Hooks
export { useECU } from './hooks/useECU';
export { useDTCRetriever } from './hooks/useDTCRetriever';

// Context Components
export { ECUContext, ECUProvider } from './context/ECUContext';

// Export all types, constants, and utilities from the barrel file
// This includes ECUState, ECUContextValue, ECUConnectionStatus, OBD_MODE, etc.
export * from './types';
