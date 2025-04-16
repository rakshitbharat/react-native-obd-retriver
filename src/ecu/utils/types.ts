import type { PROTOCOL, ECUConnectionStatus } from './constants';
import type { RawDTCResponse } from '../retrievers/BaseDTCRetriever';

export { RawDTCResponse }; // Re-export for convenience

// Define Action Types using 'as const' for better type inference
export const ECUActionType = {
  CONNECT_START: 'CONNECT_START',
  CONNECT_SUCCESS: 'CONNECT_SUCCESS',
  CONNECT_FAILURE: 'CONNECT_FAILURE',
  DISCONNECT: 'DISCONNECT',
  SET_ECU_INFO: 'SET_ECU_INFO', // Used for updating info like voltage
  RESET: 'RESET', // Action to reset the ECU state completely

  // DTC related actions (kept for potential use, no changes needed)
  FETCH_DTCS_START: 'FETCH_DTCS_START',
  FETCH_DTCS_SUCCESS: 'FETCH_DTCS_SUCCESS',
  FETCH_DTCS_FAILURE: 'FETCH_DTCS_FAILURE',
  CLEAR_DTCS_START: 'CLEAR_DTCS_START',
  CLEAR_DTCS_SUCCESS: 'CLEAR_DTCS_SUCCESS',
  CLEAR_DTCS_FAILURE: 'CLEAR_DTCS_FAILURE',

  // Raw DTC actions (kept for potential use, no changes needed)
  FETCH_RAW_DTCS_START: 'FETCH_RAW_DTCS_START',
  FETCH_RAW_CURRENT_DTCS_SUCCESS: 'FETCH_RAW_CURRENT_DTCS_SUCCESS',
  FETCH_RAW_PENDING_DTCS_SUCCESS: 'FETCH_RAW_PENDING_DTCS_SUCCESS',
  FETCH_RAW_PERMANENT_DTCS_SUCCESS: 'FETCH_RAW_PERMANENT_DTCS_SUCCESS',
  FETCH_RAW_DTCS_FAILURE: 'FETCH_RAW_DTCS_FAILURE',
} as const;

// Type for the action object used in the reducer
export type ECUAction = {
  type: keyof typeof ECUActionType; // Use keys of the const object
  payload?: ECUActionPayload; // Payload is optional
};

// Interface for the payload of ECU actions
export interface ECUActionPayload {
  protocol?: PROTOCOL | null; // Protocol number (enum or null)
  protocolName?: string | null; // Descriptive name of the protocol
  detectedEcuAddresses?: string[]; // Array of detected ECU addresses (headers)
  error?: string; // Error message string
  voltage?: string | undefined | null; // Voltage string (e.g., "12.3V") or null/undefined
  data?: RawDTCResponse | null; // Payload for raw DTC data actions
  // Add other potential payload fields if needed
  dtcs?: string[] | null; // For FETCH_DTCS_SUCCESS potentially
}

// Interface for the value provided by the ECUContext
export interface ECUContextValue {
  state: ECUState; // The current state of the ECU connection and data
  connectWithECU: () => Promise<boolean>; // Function to initiate ECU connection sequence
  disconnectECU: () => Promise<void>; // Function to disconnect from ECU (protocol close, reset state)
  getECUInformation: () => Promise<void>; // Function to fetch adapter/ECU info (e.g., voltage)
  getActiveProtocol: () => { protocol: PROTOCOL | null; name: string | null }; // Get current protocol info
  // Non-ECU related functions (signatures remain the same)
  getVIN: () => Promise<string | null>;
  // eslint-disable-next-line no-unused-vars
  clearDTCs: (skipVerification?: boolean) => Promise<boolean>;
  getRawCurrentDTCs: () => Promise<RawDTCResponse | null>;
  getRawPendingDTCs: () => Promise<RawDTCResponse | null>;
  getRawPermanentDTCs: () => Promise<RawDTCResponse | null>;
  // The core function for sending commands via Bluetooth
  sendCommand: SendCommandFunction;
}

// Interface describing the state managed by the ECU reducer
export interface ECUState {
  status: ECUConnectionStatus; // Current connection status enum
  activeProtocol: PROTOCOL | null; // Active protocol number (enum or null)
  protocolName: string | null; // Descriptive name of the active protocol
  lastError: string | null; // Last recorded error message
  deviceVoltage: string | null; // Last read device voltage (e.g., "12.3V")
  detectedEcuAddresses: string[]; // List of ECU addresses found during connection
  selectedEcuAddress: string | null; // Currently targeted ECU address (header)
  // DTC related state (remains unchanged from initial definition)
  currentDTCs: string[] | null;
  pendingDTCs: string[] | null;
  permanentDTCs: string[] | null;
  dtcLoading: boolean;
  dtcClearing: boolean;
  rawCurrentDTCs: RawDTCResponse | null;
  rawPendingDTCs: RawDTCResponse | null;
  rawPermanentDTCs: RawDTCResponse | null;
  rawDTCLoading: boolean;
}

// Type definition for the sendCommand function used throughout the ECU module
// Aligns with react-native-bluetooth-obd-manager hook's sendCommand signature
export type SendCommandFunction = (
  // eslint-disable-next-line no-unused-vars
  command: string,
  // eslint-disable-next-line no-unused-vars
  options?: number | { timeout?: number }, // Allow number (legacy) or options object for timeout
) => Promise<string | null>; // Returns the response string or null on failure/timeout

// --- Types below define configuration structures - derived from JS ElmProtocolInit/Helper ---
// --- Kept for potential future protocol detail implementation ---

/** Configuration for adaptive timing */
export interface AdaptiveTimingConfig {
  mode: 0 | 1 | 2; // ATAT mode
  timeout: number; // ATST timeout value (in hex-time units, e.g., 64 for 100ms)
  startDelay: number; // Initial delay (ms)
  minDelay: number; // Minimum delay (ms)
  maxDelay: number; // Maximum delay (ms)
  increment: number; // Increment step (ms)
  decrement: number; // Decrement step (ms)
}

/** Basic protocol configuration including timing */
export interface ProtocolTimingConfig {
  protocol: PROTOCOL;
  description: string;
  timing: AdaptiveTimingConfig;
}

/** Configuration specific to CAN protocols */
export interface CanProtocolConfig extends ProtocolTimingConfig {
  header: string; // Default functional header (e.g., 7DF, 18DB33F1)
  receiveFilter: string; // Default ECU response header (e.g., 7E8, 18DAF110)
  flowControlHeader: string; // Header used for flow control (e.g., 7E0, 18DA10F1)
  isExtended: boolean; // 29-bit ID flag
  formatCommands?: string[]; // e.g., ['ATCAF1']
  /** Function that generates flow control setup commands based on a header value */
  // disable eslint here
  // eslint-disable-next-line no-unused-vars
  flowControlCommands: (fcHeader: string) => string[]; // Returns commands like ['ATFCSH header']
}

// Configuration for non-CAN protocols (example for KWP)
export interface KwpProtocolConfig extends ProtocolTimingConfig {
  initType: 'fast' | 'slow';
  formatCommands?: string[]; // e.g., ['ATCAF0']
  // KWP specific params if needed
}

// --- Types below were in the original types.ts, kept for reference ---
// --- Might overlap or be superseded by the above ---

export interface SendCommandOptions {
  timeoutMs?: number;
}

// Combining HeaderFormatConfig and FlowControlConfig into Protocol details if needed later
export interface ProtocolConfig {
  protocolNumber: number;
  description: string;
  headerFormatConfig?: HeaderFormatConfig; // Optional: Refined header details
  baudRate?: number; // Informational, might not be readily available
  flowControlEnabled?: boolean; // Does protocol use ISO-TP Flow Control?
  flowControlConfig?: FlowControlConfig; // Optional: Refined FC details
  timing?: TimingConfig; // Refined timing details
  initSequence?: string[]; // Initial setup commands
  supportedModes?: string[]; // Informational
  errorPatterns?: RegExp[]; // Informational
}

export interface TimingConfig {
  p1Max?: number; // Informational: Max ECU inter-byte time (ms)
  p2Max?: number; // Informational: Max Request->Response time (ms)
  p3Min?: number; // Informational: Min Response->Request time (ms)
  p4Min?: number; // Informational: Min Request inter-byte time (ms)
  adaptiveMode: 0 | 1 | 2; // ELM ATAT mode
  // Merge adaptive timing config here from AdaptiveTimingConfig?
  adaptiveStart?: number;
  adaptiveMin?: number;
  adaptiveMax?: number;
  increment?: number;
  decrement?: number;
  responseTimeoutMs: number; // Target response timeout (ms) for ATST
}

// Ensure all properties are optional if they aren't always present
export interface FlowControlConfig {
  blockSize?: number; // FC Block Size (BS) for ATFC SD
  separationTime?: number; // FC Separation Time (ST) in ms for ATFC SD
  flowControlHeader?: string; // Header for outgoing FC frames (ATFC SH)
  flowControlMode?: 0 | 1 | 2; // FC Mode (ATFC SM)
  maxWaitFrames?: number; // Informational
}

// Ensure all properties are optional if they aren't always present
export interface HeaderFormatConfig {
  type?: '11bit' | '29bit';
  format?: 'CAN' | 'ISO' | 'KWP' | 'J1850' | 'OTHER'; // Informational
  addressingMode?: 'physical' | 'functional'; // Informational
  defaultTxHeader?: string; // e.g., 7DF, 18DB33F1
  defaultRxHeader?: string; // e.g., 7E8, 18DAF110
  defaultFilter?: string; // For ATCF
  defaultMask?: string; // For ATCM
}

// Type for Service Modes used by DTC Retrievers (remains unchanged)
export interface ServiceMode {
  REQUEST: string;
  RESPONSE: number;
  NAME: string;
  DESCRIPTION: string;
  troubleCodeType: string;
  flowControl?: boolean;
  timing?: Partial<TimingConfig>;
}
