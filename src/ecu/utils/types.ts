import { type Peripheral } from 'react-native-ble-manager';
import type { PROTOCOL, ECUConnectionStatus } from './constants';
import type { RawDTCResponse } from '../retrievers/BaseDTCRetriever';

export { RawDTCResponse }; // Re-export for convenience

/**
 * Information about the OBD adapter itself.
 */
export interface AdapterInfo {
  /** Adapter voltage reading, if available (e.g., "12.3V"). */
  voltage: string | null;
}

/**
 * Action types for ECU state management
 *
 * These constants define all possible actions that can be dispatched
 * to update the ECU state through the reducer.
 */
export const ECUActionType = {
  /** Indicates connection attempt has started */
  CONNECT_START: 'CONNECT_START',
  /** Indicates connection was successful, with protocol info */
  CONNECT_SUCCESS: 'CONNECT_SUCCESS',
  /** Indicates connection attempt failed, with error info */
  CONNECT_FAILURE: 'CONNECT_FAILURE',
  /** Indicates ECU disconnection (protocol closed) */
  DISCONNECT: 'DISCONNECT',
  /** Indicates disconnection was successful */
  DISCONNECT_SUCCESS: 'DISCONNECT_SUCCESS',
  DEVICE_STATE_CHANGE: 'DEVICE_STATE_CHANGE',
  /** Updates ECU information like voltage */
  SET_ECU_INFO: 'SET_ECU_INFO', // Used for updating info like voltage
  /** Completely resets the ECU state */
  RESET: 'RESET', // Action to reset the ECU state completely

  // DTC related actions (kept for potential use, no changes needed)
  /** Indicates DTC retrieval has started */
  FETCH_DTCS_START: 'FETCH_DTCS_START',
  /** Indicates DTC retrieval was successful, with DTC data */
  FETCH_DTCS_SUCCESS: 'FETCH_DTCS_SUCCESS',
  /** Indicates DTC retrieval failed, with error info */
  FETCH_DTCS_FAILURE: 'FETCH_DTCS_FAILURE',
  /** Indicates DTC clearing process has started */
  CLEAR_DTCS_START: 'CLEAR_DTCS_START',
  /** Indicates DTC clearing was successful */
  CLEAR_DTCS_SUCCESS: 'CLEAR_DTCS_SUCCESS',
  /** Indicates DTC clearing failed, with error info */
  CLEAR_DTCS_FAILURE: 'CLEAR_DTCS_FAILURE',

  // Raw DTC actions (kept for potential use, no changes needed)
  /** Indicates raw DTC retrieval has started */
  FETCH_RAW_DTCS_START: 'FETCH_RAW_DTCS_START',
  /** Indicates raw current DTCs (Mode 03) were successfully retrieved */
  FETCH_RAW_CURRENT_DTCS_SUCCESS: 'FETCH_RAW_CURRENT_DTCS_SUCCESS',
  /** Indicates raw pending DTCs (Mode 07) were successfully retrieved */
  FETCH_RAW_PENDING_DTCS_SUCCESS: 'FETCH_RAW_PENDING_DTCS_SUCCESS',
  /** Indicates raw permanent DTCs (Mode 0A) were successfully retrieved */
  FETCH_RAW_PERMANENT_DTCS_SUCCESS: 'FETCH_RAW_PERMANENT_DTCS_SUCCESS',
  /** Indicates raw DTC retrieval failed, with error info */
  FETCH_RAW_DTCS_FAILURE: 'FETCH_RAW_DTCS_FAILURE',
  SYNC_STATE: 'SYNC_STATE' as const,
  BLUETOOTH_STATE_CHANGE: 'BLUETOOTH_STATE_CHANGE',
} as const;

export type ECUActionTypes = (typeof ECUActionType)[keyof typeof ECUActionType];

/**
 * Type definition for ECU actions passed to the reducer
 *
 * This represents the standard action object structure used throughout
 * the ECU state management system.
 */
export interface ECUActionPayload {
  protocol?: PROTOCOL | null;
  protocolName?: string | null;
  voltage?: number | null;
  detectedEcuAddresses?: string[];
  error?: string; // Single error field
  initCommand?: string;
  initResponse?: string;
  command?: string;
  response?: string;
  data?: RawDTCResponse | null;
  dtcs?: string[];
  bluetoothState?: 'on' | 'off';
  device?: {
    connected: boolean;
    services?: string[];
    characteristics?: Array<{
      service: string;
      characteristic: string;
    }>;
  };
}

// Remove duplicate ECUAction type and combine into one
export type ECUAction = {
  type: keyof typeof ECUActionType;
  payload?: ECUActionPayload;
};

export interface ExtendedPeripheral extends Peripheral {
  services?: Array<{ uuid: string }>;
  characteristics?: Array<{
    service: string;
    characteristic: string;
  }>;
}

export interface ECUState {
  status: ECUConnectionStatus;
  activeProtocol: PROTOCOL | null;
  protocolName: string | null;
  voltage: number | null;
  deviceVoltage: number | null;
  lastError: string | null;
  device?: {
    connected: boolean;
    services?: string[];
    characteristics?: Array<{
      service: string;
      characteristic: string;
    }>;
  };
  detectedEcuAddresses?: string[];
  selectedEcuAddress?: string | null;
  currentDTCs: string[];
  pendingDTCs: string[];
  rawCurrentDTCs: RawDTCResponse | null;
  rawPendingDTCs: RawDTCResponse | null;
  rawPermanentDTCs: RawDTCResponse | null;
  dtcLoading: boolean;
  dtcClearing: boolean;
  rawDTCLoading: boolean;
  initializationState: {
    initAttempts: number;
    maxInitAttempts: number;
    lastInitCommand?: string;
  };
  ecuDetectionState: {
    inProgress: boolean;
    searchAttempts: number;
    maxSearchAttempts: number;
    lastAttemptTime?: number;
    currentStep?: string;
  };
  error?: string;
}

/**
 * Configuration for header format in protocols
 */
export interface HeaderFormatConfig {
  type: '11bit' | '29bit';
  format: 'CAN' | 'ISO' | 'KWP';
  addressingMode: 'functional' | 'physical';
  defaultTxHeader: string;
  defaultRxHeader: string;
}

/**
 * Interface for the value provided by the ECUContext
 *
 * This interface defines all functions and data exposed by the ECU context.
 * It serves as the main API for interacting with the vehicle's ECU.
 *
 * @example
 * ```typescript
 * // In a React component:
 * function VehicleInfo() {
 *   const { state, connectWithECU, getVIN } = useECU();
 *
 *   const handleConnect = async () => {
 *     const success = await connectWithECU();
 *     if (success) {
 *       console.log(`Connected with protocol: ${state.protocolName}`);
 *     }
 *   };
 *
 *   return (
 *     <View>
 *       <Text>Status: {state.status}</Text>
 *       <Button title="Connect" onPress={handleConnect} />
 *       {state.status === ECUConnectionStatus.CONNECTED && (
 *         <Button title="Get VIN" onPress={async () => {
 *           const vin = await getVIN();
 *           console.log(`Vehicle VIN: ${vin}`);
 *         }} />
 *       )}
 *     </View>
 *   );
 * }
 * ```
 */
export interface ECUContextValue {
  /** The current state of the ECU connection and data */
  state: ECUState;

  /**
   * Connects to the vehicle's ECU
   *
   * This function handles the complete connection process:
   * 1. Sends initialization commands to the OBD adapter
   * 2. Detects and configures the appropriate OBD protocol
   * 3. Establishes communication with the vehicle's ECUs
   *
   * @returns A Promise resolving to true if connection was successful, false otherwise
   * @example
   * ```typescript
   * const success = await connectWithECU();
   * if (success) {
   *   console.log("Successfully connected to ECU");
   * } else {
   *   console.error("Failed to connect to ECU");
   * }
   * ```
   */
  connectWithECU: () => Promise<boolean>;

  /**
   * Disconnects from the ECU
   *
   * Sends the appropriate protocol close command and resets the internal state.
   * This does not disconnect the Bluetooth connection itself.
   *
   * @returns A Promise that resolves when disconnection is complete
   * @example
   * ```typescript
   * await disconnectECU();
   * console.log("Disconnected from ECU");
   * ```
   */
  disconnectECU: () => Promise<void>;

  /**
   * Updates ECU information like voltage
   *
   * Retrieves the latest information from the ECU/adapter and updates the state.
   *
   * @returns A Promise that resolves when information has been updated
   * @example
   * ```typescript
   * await getECUInformation();
   * console.log(`Vehicle voltage: ${state.deviceVoltage}`);
   * ```
   */
  getECUInformation: () => Promise<void>;

  /**
   * Gets information about the currently active protocol
   *
   * @returns Object containing protocol number and name
   * @example
   * ```typescript
   * const { protocol, name } = getActiveProtocol();
   * console.log(`Using protocol: ${name} (${protocol})`);
   * ```
   */
  getActiveProtocol: () => { protocol: PROTOCOL | null; name: string | null };

  /**
   * Retrieves the Vehicle Identification Number (VIN)
   *
   * Sends Mode 09 PID 02 command to request the VIN from the vehicle.
   *
   * @returns Promise resolving to the VIN string or null if it could not be read
   * @example
   * ```typescript
   * const vin = await getVIN();
   * if (vin) {
   *   console.log(`Vehicle VIN: ${vin}`);
   * } else {
   *   console.error("Could not retrieve VIN");
   * }
   * ```
   */
  getVIN: () => Promise<string | null>;

  /**
   * Clears Diagnostic Trouble Codes (DTCs)
   *
   * Sends Mode 04 command to clear all DTCs and reset the MIL (check engine light).
   *
   * @param skipVerification - Optional flag to skip verification of clear success
   * @returns Promise resolving to true if clearing was successful, false otherwise
   * @example
   * ```typescript
   * const success = await clearDTCs();
   * if (success) {
   *   console.log("Successfully cleared DTCs");
   * } else {
   *   console.error("Failed to clear DTCs");
   * }
   * ```
   */

  clearDTCs: (skipVerification?: boolean) => Promise<boolean>;

  /**
   * Gets raw current DTCs (Mode 03)
   *
   * Retrieves DTCs that are currently active.
   *
   * @returns Promise resolving to raw DTC response or null if unavailable
   * @example
   * ```typescript
   * const dtcs = await getRawCurrentDTCs();
   * if (dtcs && dtcs.rawString) {
   *   console.log(`Raw DTCs: ${dtcs.rawString}`);
   * }
   * ```
   */
  getRawCurrentDTCs: () => Promise<RawDTCResponse | null>;

  /**
   * Gets raw pending DTCs (Mode 07)
   *
   * Retrieves DTCs that have occurred but are not currently active.
   *
   * @returns Promise resolving to raw DTC response or null if unavailable
   * @example
   * ```typescript
   * const dtcs = await getRawPendingDTCs();
   * if (dtcs && dtcs.rawString) {
   *   console.log(`Raw pending DTCs: ${dtcs.rawString}`);
   * }
   * ```
   */
  getRawPendingDTCs: () => Promise<RawDTCResponse | null>;

  /**
   * Gets raw permanent DTCs (Mode 0A)
   *
   * Retrieves DTCs that cannot be cleared with Mode 04.
   *
   * @returns Promise resolving to raw DTC response or null if unavailable
   * @example
   * ```typescript
   * const dtcs = await getRawPermanentDTCs();
   * if (dtcs && dtcs.rawString) {
   *   console.log(`Raw permanent DTCs: ${dtcs.rawString}`);
   * }
   * ```
   */
  getRawPermanentDTCs: () => Promise<RawDTCResponse | null>;

  /**
   * Sends a raw command to the OBD adapter
   *
   * This is a low-level function that allows sending arbitrary commands.
   * Use with caution as improper commands may disrupt the connection.
   *
   * @param command - The command string to send (e.g., "0100", "ATDPN")
   * @param options - Optional timeout in ms or options object
   * @returns Promise resolving to the response string or null on failure
   * @example
   * ```typescript
   * // Get supported PIDs (Mode 01)
   * const response = await sendCommand("0100");
   * if (response) {
   *   console.log(`Response: ${response}`);
   * }
   *
   * // With custom timeout
   * const response = await sendCommand("0902", { timeout: 10000 });
   * ```
   */
  sendCommand: SendCommandFunction;
  /**
   * Sends a command to the OBD adapter and waits for a response
   *
   * This function is used for sending commands and receiving responses.
   * It handles the command formatting and response parsing.
   *
   * @param command - The command string to send (e.g., "0100", "ATDPN")
   * @param options - Optional timeout in ms or options object
   * @returns Promise resolving to the response string or null on failure
   * @example
   * ```typescript
   * const response = await sendCommand("0100");
   * if (response) {
   *   console.log(`Response: ${response}`);
   * }
   * ```
   */
  sendCommandWithResponse: SendCommandFunction;
}

/**
 * Type definition for the sendCommand function used throughout the ECU module
 * Aligns with react-native-bluetooth-obd-manager hook's sendCommand signature
 */
export type SendCommandFunction = (
  command: string,

  options?: number | { timeout?: number }, // Allow number (legacy) or options object for timeout
) => Promise<string | null>; // Returns the response string or null on failure/timeout

/**
 * Represents the response structure containing raw data chunks,
 * as returned directly by the react-native-bluetooth-obd-manager hook.
 * This type might differ slightly from the internal ChunkedResponse.
 */
export interface BluetoothChunkedResponse {
  chunks: Uint8Array[];
  rawResponse?: number[][]; // Optional property
}

/**
 * Represents the response structure containing raw data chunks.
 * This is the type used internally within react-native-obd-retriever.
 */
export interface ChunkedResponse {
  /** Array of raw data chunks received. */
  chunks: Uint8Array[];
  /** The command that generated this response. */
  command: string;
  /** Optional raw response as array of number arrays (bytes per chunk). */
  rawResponse?: number[][];
  /** Total number of bytes received across all chunks. */
  totalBytes: number;
}

/**
 * Type definition for a function that sends a command and returns a raw, chunked response.
 * This function returns the local ChunkedResponse type.
 */
export type SendCommandRawFunction = (
  command: string,
  options?: number | { timeout?: number },
) => Promise<ChunkedResponse>; // Returns the local ChunkedResponse type

/**
 * Configuration for adaptive timing in OBD communication
 *
 * Adaptive timing is a feature of ELM327 adapters that dynamically adjusts
 * the time between commands based on vehicle response times.
 *
 * @example
 * ```typescript
 * // Configure adaptive timing for CAN protocol
 * const canTimingConfig: AdaptiveTimingConfig = {
 *   mode: 1,             // Use ELM's adaptive timing mode 1
 *   timeout: 64,         // ~100ms timeout (in ELM hex-time units)
 *   startDelay: 20,      // Start with 20ms delay
 *   minDelay: 10,        // Never go below 10ms
 *   maxDelay: 200,       // Never exceed 200ms
 *   increment: 4,        // Increase by 4ms when needed
 *   decrement: 2         // Decrease by 2ms when possible
 * };
 * ```
 */
export interface AdaptiveTimingConfig {
  /**
   * Adaptive timing mode (0=off, 1=normal, 2=aggressive)
   * Corresponds to ELM327 ATATx command
   */
  mode: 0 | 1 | 2;

  /**
   * Timeout value in ELM327 hex-time units
   * Used with ATSTxx command (e.g., 64 = ~100ms)
   */
  timeout: number;

  /** Initial delay between commands in milliseconds */
  startDelay: number;

  /** Minimum allowed delay in milliseconds */
  minDelay: number;

  /** Maximum allowed delay in milliseconds */
  maxDelay: number;

  /** How much to increase delay when timeout occurs (ms) */
  increment: number;

  /** How much to decrease delay when responses are fast (ms) */
  decrement: number;
}

/**
 * Base protocol configuration with timing settings
 *
 * This interface provides the fundamental properties required
 * for any OBD protocol configuration.
 *
 * @example
 * ```typescript
 * const baseConfig: ProtocolTimingConfig = {
 *   protocol: PROTOCOL.ISO_15765_4_CAN_11BIT_500K,
 *   description: "CAN 11-bit 500kbps",
 *   timing: {
 *     mode: 1,
 *     timeout: 64,
 *     startDelay: 20,
 *     minDelay: 10,
 *     maxDelay: 100,
 *     increment: 4,
 *     decrement: 2
 *   }
 * };
 * ```
 */
export interface ProtocolTimingConfig {
  /** Protocol identifier from PROTOCOL enum */
  protocol: PROTOCOL;

  /** Human-readable description of the protocol */
  description: string;

  /** Protocol-specific timing configuration */
  timing: AdaptiveTimingConfig;
}

/**
 * Configuration specific to CAN protocols (ISO 15765-4)
 *
 * CAN protocols require specific header configurations and flow control settings.
 * This interface extends the base protocol config with CAN-specific properties.
 *
 * @example
 * ```typescript
 * const canConfig: CanProtocolConfig = {
 *   protocol: PROTOCOL.ISO_15765_4_CAN_11BIT_500K,
 *   description: "CAN 11-bit 500kbps",
 *   timing: adaptiveTimingConfig,
 *   header: "7DF",                   // Standard functional addressing header
 *   receiveFilter: "7E8",            // Default ECU response filter
 *   flowControlHeader: "7E0",        // Flow control header
 *   isExtended: false,               // Standard 11-bit addressing
 *   formatCommands: ["ATCAF1"],      // Enable CAN auto-formatting
 *   flowControlCommands: (fcHeader) => [
 *     `ATFCSH${fcHeader}`,           // Set flow control header
 *     "ATFCSD300000",                // Set flow control data
 *     "ATFCSM1"                      // Set flow control mode
 *   ]
 * };
 * ```
 */
export interface CanProtocolConfig extends ProtocolTimingConfig {
  /**
   * Default functional header for sending commands
   * e.g., "7DF" for 11-bit CAN, "18DB33F1" for 29-bit CAN
   */
  header: string;

  /**
   * Default ECU response header filter
   * e.g., "7E8" for primary ECU in 11-bit CAN
   */
  receiveFilter: string;

  /**
   * Header used for flow control frames
   * e.g., "7E0" for 11-bit CAN flow control
   */
  flowControlHeader: string;

  /**
   * Whether the protocol uses extended (29-bit) CAN IDs
   * true for 29-bit, false for 11-bit
   */
  isExtended: boolean;

  /**
   * Optional array of formatting commands to send during initialization
   * e.g., ["ATCAF1"] to enable automatic formatting
   */
  formatCommands?: string[];

  /**
   * Function that generates flow control setup commands based on a header value
   * Returns commands like ['ATFCSH header', 'ATFCSD300000', 'ATFCSM1']
   *
   * @param fcHeader - Flow control header to use in commands
   * @returns Array of AT commands for flow control setup
   */

  flowControlCommands: (fcHeader: string) => string[];
}

/**
 * Configuration for KWP2000 (ISO 14230-4) protocols
 *
 * KWP2000 protocols support both slow (5-baud) and fast initialization.
 * This interface defines KWP-specific protocol configuration.
 *
 * @example
 * ```typescript
 * const kwpConfig: KwpProtocolConfig = {
 *   protocol: PROTOCOL.ISO_14230_4_KWP_FAST,
 *   description: "KWP2000 Fast Init",
 *   timing: adaptiveTimingConfig,
 *   initType: 'fast',                // Use fast initialization
 *   formatCommands: ["ATCAF0"]       // Disable automatic formatting
 * };
 * ```
 */
export interface KwpProtocolConfig extends ProtocolTimingConfig {
  /**
   * Initialization type for KWP protocol
   * - 'fast': Uses fast initialization (ISO 14230-4 fast init)
   * - 'slow': Uses 5-baud initialization (ISO 14230-4 5-baud init)
   */
  initType: 'fast' | 'slow';

  /**
   * Optional array of formatting commands to send during initialization
   * Typically ["ATCAF0"] for KWP protocols
   */
  formatCommands?: string[];

  // KWP specific params if needed
}

// --- Types below were in the original types.ts, kept for reference ---
// --- Might overlap or be superseded by the above ---

/**
 * Options for sending commands to the OBD adapter
 *
 * @example
 * ```typescript
 * // Send a command with a custom timeout
 * const response = await sendCommand("0902", { timeoutMs: 10000 });
 * ```
 */
export interface SendCommandOptions {
  /**
   * Timeout in milliseconds before the command is considered failed
   * If not specified, a default timeout (typically 5000ms) will be used
   */
  timeoutMs?: number;
}

/**
 * Complete protocol configuration combining all protocol details
 *
 * This interface provides a comprehensive configuration for an OBD protocol,
 * including header format, timing, flow control, and initialization sequence.
 *
 * @example
 * ```typescript
 * // Full configuration for CAN 11-bit protocol
 * const canConfig: ProtocolConfig = {
 *   protocolNumber: PROTOCOL.ISO_15765_4_CAN_11BIT_500K,
 *   description: "ISO 15765-4 CAN (11 bit ID, 500 kbps)",
 *   baudRate: 500000,
 *   flowControlEnabled: true,
 *   headerFormatConfig: {
 *     type: "11bit",
 *     format: "CAN",
 *     addressingMode: "functional",
 *     defaultTxHeader: "7DF",
 *     defaultRxHeader: "7E8"
 *   },
 *   flowControlConfig: {
 *     blockSize: 0,
 *     separationTime: 0,
 *     flowControlHeader: "7E0",
 *     flowControlMode: 1
 *   },
 *   timing: {
 *     adaptiveMode: 1,
 *     adaptiveStart: 20,
 *     adaptiveMin: 10,
 *     adaptiveMax: 100,
 *     responseTimeoutMs: 100
 *   },
 *   initSequence: ["ATSP6", "ATCAF1", "ATSH7DF"]
 * };
 * ```
 */
export interface ProtocolConfig {
  /**
   * Protocol identifier from PROTOCOL enum or raw numeric value
   */
  protocolNumber: number;

  /**
   * Human-readable description of the protocol
   */
  description: string;

  /**
   * Optional header format configuration
   * Defines header structure, addressing mode, and default headers
   */
  headerFormatConfig?: HeaderFormatConfig;

  /**
   * Optional communication speed in bits per second
   * May not be directly configurable on some adapters
   */
  baudRate?: number;

  /**
   * Whether the protocol uses ISO-TP flow control for multi-frame messages
   * Typically true for CAN protocols, false for KWP and ISO9141
   */
  flowControlEnabled?: boolean;

  /**
   * Optional flow control configuration
   * Used when flowControlEnabled is true
   */
  flowControlConfig?: FlowControlConfig;

  /**
   * Optional timing configuration for the protocol
   * Defines timing parameters for communication
   */
  timing?: TimingConfig;

  /**
   * Optional array of initialization commands to set up the protocol
   * These are sent to the adapter during protocol initialization
   */
  initSequence?: string[];

  /**
   * Optional array of OBD service modes supported by this protocol
   * For informational purposes
   */
  supportedModes?: string[];

  /**
   * Optional array of regex patterns matching error responses for this protocol
   * For error detection
   */
  errorPatterns?: RegExp[];
}

/**
 * Configuration for protocol timing parameters
 *
 * This interface defines all timing-related settings for OBD communication,
 * including standard timing parameters (P1, P2, etc.) and adaptive timing.
 *
 * @example
 * ```typescript
 * const timingConfig: TimingConfig = {
 *   // Standard OBD timing parameters (informational)
 *   p1Max: 5,              // Maximum inter-byte time for ECU
 *   p2Max: 50,             // Maximum time between request and response
 *   p3Min: 55,             // Minimum time between responses and new requests
 *   p4Min: 5,              // Minimum inter-byte time for request
 *
 *   // Adaptive timing configuration
 *   adaptiveMode: 1,       // Use ELM's adaptive timing
 *   adaptiveStart: 32,     // Initial delay (ms)
 *   adaptiveMin: 8,        // Minimum delay (ms)
 *   adaptiveMax: 200,      // Maximum delay (ms)
 *   increment: 8,          // Increment step (ms)
 *   decrement: 4,          // Decrement step (ms)
 *
 *   // Response timeout
 *   responseTimeoutMs: 100 // Response timeout (ms)
 * };
 * ```
 */
export interface TimingConfig {
  /**
   * Maximum inter-byte time for ECU responses (P1 timing parameter)
   * Maximum time in milliseconds between bytes in an ECU's response
   * Informational only - not directly configurable on most adapters
   */
  p1Max?: number;

  /**
   * Maximum time between request and response (P2 timing parameter)
   * Maximum time in milliseconds between end of request and start of response
   * Informational only - not directly configurable on most adapters
   */
  p2Max?: number;

  /**
   * Minimum time between response and new request (P3 timing parameter)
   * Minimum time in milliseconds between end of response and start of new request
   * Informational only - not directly configurable on most adapters
   */
  p3Min?: number;

  /**
   * Minimum inter-byte time for request (P4 timing parameter)
   * Minimum time in milliseconds between bytes in a request to the ECU
   * Informational only - not directly configurable on most adapters
   */
  p4Min?: number;

  /**
   * Adaptive timing mode (0=off, 1=normal, 2=aggressive)
   * Corresponds to ELM327 ATATx command
   */
  adaptiveMode: 0 | 1 | 2;

  /**
   * Initial adaptive timing delay in milliseconds
   * Starting point for adaptive timing algorithm
   */
  adaptiveStart?: number;

  /**
   * Minimum allowed adaptive timing delay in milliseconds
   * Prevents timing from becoming too aggressive
   */
  adaptiveMin?: number;

  /**
   * Maximum allowed adaptive timing delay in milliseconds
   * Prevents excessive delays when ECU is slow to respond
   */
  adaptiveMax?: number;

  /**
   * How much to increase delay when timeout occurs (ms)
   * Controls the rate at which timing becomes more conservative
   */
  increment?: number;

  /**
   * How much to decrease delay when responses are fast (ms)
   * Controls the rate at which timing becomes more aggressive
   */
  decrement?: number;

  /**
   * Target response timeout in milliseconds
   * Used to set the ELM's timeout (ATST command)
   */
  responseTimeoutMs: number;
}

/**
 * Configuration for ISO-TP (ISO 15765-2) flow control parameters
 *
 * Flow control is used in CAN protocols for managing multi-frame messages.
 * This interface defines the parameters that control flow control behavior.
 *
 * @example
 * ```typescript
 * const flowControlConfig: FlowControlConfig = {
 *   blockSize: 0,              // Request all frames at once (no block limit)
 *   separationTime: 0,         // No minimum separation time
 *   flowControlHeader: "7E0",  // Header to use for flow control frames
 *   flowControlMode: 1,        // Standard flow control mode
 *   maxWaitFrames: 10          // Maximum number of wait frames to accept
 * };
 *
 * // Apply to adapter
 * await sendCommand(`ATFCSH${flowControlConfig.flowControlHeader}`);
 * await sendCommand(`ATFCSD${flowControlConfig.blockSize}00000`);
 * await sendCommand(`ATFCSM${flowControlConfig.flowControlMode}`);
 * ```
 */
export interface FlowControlConfig {
  /**
   * Flow Control Block Size (BS)
   * Number of consecutive frames to receive before sending flow control
   * 0 = Receive all frames without additional flow control
   * Used with ATFC SD command
   */
  blockSize?: number;

  /**
   * Flow Control Separation Time (ST) in milliseconds
   * Minimum time between consecutive frames
   * 0 = No minimum separation time
   * Used with ATFC SD command
   */
  separationTime?: number;

  /**
   * Header for outgoing flow control frames
   * Based on the responding ECU's address
   * Used with ATFC SH command
   */
  flowControlHeader?: string;

  /**
   * Flow Control Mode
   * 0 = Flow control off
   * 1 = Standard flow control (default)
   * 2 = Wait for FC before continuing
   * Used with ATFC SM command
   */
  flowControlMode?: 0 | 1 | 2;

  /**
   * Maximum number of wait (FC.WT) frames to accept
   * Informational only - not directly configurable on most adapters
   */
  maxWaitFrames?: number;
}

/**
 * Configuration for OBD-II service modes used by diagnostic functions
 *
 * This interface defines the parameters for a specific OBD-II service mode,
 * including request/response format and special handling requirements.
 *
 * @example
 * ```typescript
 * // Configuration for Mode 03 (Current DTCs)
 * const currentDtcMode: ServiceMode = {
 *   REQUEST: '03',              // Service 03 request
 *   RESPONSE: 0x43,             // Expected response ID (0x40 + mode)
 *   NAME: 'CURRENT_DTC',        // Identifier name
 *   DESCRIPTION: 'Get current DTCs',  // Human-readable description
 *   troubleCodeType: 'current', // Type of trouble codes
 *   flowControl: true,          // May require flow control (multi-frame)
 *   timing: {                   // Custom timing for this service
 *     adaptiveMode: 1,
 *     responseTimeoutMs: 200    // Longer timeout for DTC retrieval
 *   }
 * };
 * ```
 */
export interface ServiceMode {
  /**
   * OBD service mode request ID as a string (e.g., '03', '07', '0A')
   * Used to build the request command
   */
  REQUEST: string;

  /**
   * Expected response identifier (usually 0x40 + mode number)
   * For example, mode 03 expects 0x43 as the response ID
   */
  RESPONSE: number;

  /**
   * Identifier name for this service mode
   * Used for logging and identification
   */
  NAME: string;

  /**
   * Human-readable description of what this service mode does
   */
  DESCRIPTION: string;

  /**
   * Type of diagnostic trouble codes returned by this mode
   * (e.g., 'current', 'pending', 'permanent')
   */
  troubleCodeType: string;

  /**
   * Whether this service mode may require flow control (multi-frame messages)
   * Typically true for services that return variable-length data
   */
  flowControl?: boolean;

  /**
   * Optional custom timing configuration for this service mode
   * Allows for service-specific timing parameters
   */
  timing?: Partial<TimingConfig>;
}

/**
 * Helper type for state update promises
 */
export type StateUpdatePromise = Promise<void>;
