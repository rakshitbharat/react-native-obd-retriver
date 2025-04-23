/**
 * Command configuration with timing
 */
export interface CommandConfig {
  cmd: string;
  delay: number;
}

/**
 * CAN configuration for a specific protocol type
 */
export interface CANConfig {
  desc: string;
  header: string;
  receiveAddr: string;
  flowAddr: string;
  commands: CommandConfig[];
  canType: '11bit' | '29bit'; // Add CAN type
  adaptiveTimingMode: 0 | 1 | 2; // Preferred AT mode
}

/**
 * VIN constants configuration
 */
export interface VINConstants {
  COMMAND: string;
  TIMEOUT: number;
  RETRIES: number;
  DELAYS: {
    INIT: number;
    COMMAND: number;
    PROTOCOL: number;
    ADAPTIVE_BASE: number; // Base delay for adaptive timing
  };
  INIT_SEQUENCE_PRE_PROTOCOL: CommandConfig[]; // Commands before protocol set
  INIT_SEQUENCE_POST_PROTOCOL: CommandConfig[]; // Commands after protocol set
  CAN_CONFIGS: CANConfig[];
  FLOW_CONTROL_CONFIGS: {
    // Define flow control variations
    fcsh: string; // Placeholder, will be replaced by config.flowAddr
    fcsd: string;
    fcsm: string;
    desc: string;
  }[];
}

/**
 * Response validation result
 */
export interface ResponseValidation {
  error: string | null;
  rawString: string;
  cleanHex: string;
}

/**
 * Raw chunked response from the adapter
 */
export interface ChunkedResponse {
  chunks: (number[] | Uint8Array)[];
  command: string;
  totalBytes: number;
  rawResponse?: number[][]; // Make optional and use number[][] to match utils/types
}

/**
 * Command response handlers
 */
export type SendCommandFunction = (command: string) => Promise<string | null>;
export type SendCommandRawFunction = (
  command: string,
  options?: { timeout?: number },
) => Promise<ChunkedResponse | null>;

/**
 * ECU Store state
 */
export interface ECUStoreState {
  status: string;
  activeProtocol: number | null; // Allow null to match ECUState
  selectedEcuAddress?: string;
}

export interface ServiceMode {
  /** OBD-II service mode request code (e.g., '03', '07', '0A') */
  REQUEST: string;

  /** Expected response code value (e.g., 0x43, 0x47, 0x4A) */
  RESPONSE: number;

  /** Service mode name identifier */
  NAME: string;

  /** Human-readable description of the service mode */
  DESCRIPTION: string;

  /** Type identifier used for DTC classification */
  troubleCodeType: string;
}
