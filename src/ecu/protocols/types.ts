/**
 * Defines the structure for configuring CAN protocol headers and filters.
 */
export interface HeaderFormatConfig {
  format: 'CAN' | 'ISO' | 'KWP' | 'J1850' | 'OTHER'; // Protocol type
  addressingMode?: 'physical' | 'functional'; // CAN/UDS addressing
  defaultTxHeader?: string; // Default ELM ATSH value
  defaultRxHeader?: string; // Expected incoming header (for filtering)
  defaultFilter?: string; // Default ELM ATCF value
  defaultMask?: string; // Default ELM ATCM value
}

/**
 * Defines the structure for configuring message timing parameters.
 */
export interface TimingConfig {
  p1Max: number; // Informational: Max ECU inter-byte time (ms)
  p2Max: number; // Informational: Max Request->Response time (ms)
  p3Min: number; // Informational: Min Response->Request time (ms)
  p4Min: number; // Informational: Min Request inter-byte time (ms)
  adaptiveMode: 0 | 1 | 2; // ELM ATAT mode
  responseTimeoutMs: number; // Target response timeout (ms) for ATAT/ATST
  // ISO/KWP specific timings (Informational, ELM handles internally)
  isoW1?: number;
  isoW2?: number;
  isoW3?: number;
  isoW4?: number;
  isoW5?: number;
}

/**
 * Defines the structure for configuring ISO-TP (CAN) flow control.
 */
export interface FlowControlConfig {
  blockSize: number; // FC Block Size (BS) for ATFC SD
  separationTime: number; // FC Separation Time (ST) in ms for ATFC SD
  flowControlHeader?: string; // Header for outgoing FC frames (ATFC SH)
  flowControlMode: 0 | 1 | 2; // FC Mode (ATFC SM)
}

/**
 * Defines the overall configuration for a specific OBD-II protocol.
 */
export interface ProtocolConfig {
  protocolNumber: number; // ELM protocol number (e.g., PROTOCOL.ISO_15765_4_CAN_11BIT_500K)
  description: string; // Human-readable name
  baudRate: number; // Communication speed (bps)
  headerFormatConfig?: HeaderFormatConfig; // Header/filter settings
  flowControlEnabled: boolean; // Does protocol use ISO-TP Flow Control?
  flowControlConfig?: FlowControlConfig; // FC parameters if enabled
  timing: TimingConfig; // Timing parameters
  initSequence?: string[]; // Optional AT commands after ATSP/ATTP
  supportedModes: string[]; // Typical OBD-II modes supported
  errorPatterns: RegExp[]; // Regex for protocol-specific errors
}
