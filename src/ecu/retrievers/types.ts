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
  functionalHeader: string;
  receiveAddr: string;
  flowAddr: string;
  canType: '11bit' | '29bit';
  adaptiveTimingMode: 0 | 1 | 2;
  commands: CommandConfig[];
}

export interface Delays {
  INIT: number;
  COMMAND: number;
  PROTOCOL: number;
  ADAPTIVE_BASE: number;
  ST_TIMEOUT: number;
}

/**
 * VIN constants configuration
 */
export interface VINConstants {
  COMMAND: string;
  TIMEOUT: number;
  RETRIES: number;
  DELAYS: Delays;
  INIT_SEQUENCE_PRE_PROTOCOL: CommandConfig[]; // Commands before protocol set
  INIT_SEQUENCE_POST_PROTOCOL: CommandConfig[]; // Commands after protocol set
  CAN_CONFIGS: CANConfig[];
  FLOW_CONTROL_CONFIGS: {
    fcsh: string;
    fcsd: string;
    fcsm: string;
    desc: string;
  }[];
  ALTERNATE_HEADERS: readonly string[];
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
 * Options for command execution
 */
export interface CommandOptions {
  timeout?: number;
  raw?: boolean;
}

/**
 * Command response handlers
 */
export type SendCommandFunction = (command: string) => Promise<string | null>;
export type SendCommandRawFunction = (
  command: string,
  options?: CommandOptions,
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
