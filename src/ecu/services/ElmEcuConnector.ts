import { TextDecoder } from 'text-encoding';

// --- Enums and Types (Keep local definitions) ---

export enum ProtocolStatus { // Ensure export
  UNDEFINED = 'UNDEFINED',
  INITIALIZING = 'INITIALIZING',
  DETECTING_PROTOCOL = 'DETECTING_PROTOCOL',
  SETTING_PROTOCOL = 'SETTING_PROTOCOL',
  ECU_DETECTING = 'ECU_DETECTING',
  ECU_DETECTED = 'ECU_DETECTED',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR',
  COMMAND_FAILED = 'COMMAND_FAILED',
  DEMO_MODE = 'DEMO_MODE',
}

export enum ElmProtocols { // Ensure export
  AUTO = 0,
  SAE_J1850_PWM = 1,
  SAE_J1850_VPW = 2,
  ISO_9141_2 = 3,
  ISO_14230_4_KWP = 4,
  ISO_14230_4_KWP_FAST = 5,
  ISO_15765_4_CAN_11B_500K = 6,
  ISO_15765_4_CAN_29B_500K = 7,
  ISO_15765_4_CAN_11B_250K = 8,
  ISO_15765_4_CAN_29B_250K = 9,
  SAE_J1939_CAN_29B_250K = 10,
  USER1_CAN_11B_125K = 11,
  USER2_CAN_11B_50K = 12,
}

export const ELM_PROTOCOL_DESCRIPTIONS: { [key in ElmProtocols]: string } = {
  // Ensure export
  [ElmProtocols.AUTO]: 'Automatic',
  [ElmProtocols.SAE_J1850_PWM]: 'SAE J1850 PWM (41.6 KBaud)',
  [ElmProtocols.SAE_J1850_VPW]: 'SAE J1850 VPW (10.4 KBaud)',
  [ElmProtocols.ISO_9141_2]: 'ISO 9141-2 (5 Baud Init)',
  [ElmProtocols.ISO_14230_4_KWP]: 'ISO 14230-4 KWP (5 Baud Init)',
  [ElmProtocols.ISO_14230_4_KWP_FAST]: 'ISO 14230-4 KWP (Fast Init)',
  [ElmProtocols.ISO_15765_4_CAN_11B_500K]:
    'ISO 15765-4 CAN (11 Bit ID, 500 KBit)',
  [ElmProtocols.ISO_15765_4_CAN_29B_500K]:
    'ISO 15765-4 CAN (29 Bit ID, 500 KBit)',
  [ElmProtocols.ISO_15765_4_CAN_11B_250K]:
    'ISO 15765-4 CAN (11 Bit ID, 250 KBit)',
  [ElmProtocols.ISO_15765_4_CAN_29B_250K]:
    'ISO 15765-4 CAN (29 Bit ID, 250 KBit)',
  [ElmProtocols.SAE_J1939_CAN_29B_250K]:
    'SAE J1939 CAN (29 bit ID, 250* kbaud)',
  [ElmProtocols.USER1_CAN_11B_125K]: 'User1 CAN (11* bit ID, 125* kbaud)',
  [ElmProtocols.USER2_CAN_11B_50K]: 'User2 CAN (11* bit ID, 50* kbaud)',
};

// --- Constants ---

// Timing constants (all in milliseconds)
const DEFAULT_TIMEOUT_MS = 5000;
const COMMAND_DELAY_MS = 100;
const RESET_DELAY_MS = 1000;
const PROTOCOL_SWITCH_DELAY_MS = 300; // Extra delay when switching protocols
const PROTOCOL_DETECT_RETRIES = 2;
const PROTOCOL_INIT_DELAY_MS = 500; // Delay after protocol initialization
const PROTOCOL_TEST_RETRY_DELAY_MS = 300;
const COMMAND_RETRY_DELAY_MS = 500;
const INITIAL_CONNECT_TIMEOUT = 10000; // 10 seconds for initial connection

const DEMO_DEVICE_ID = 'DEMO_DEVICE'; // Or your actual demo device identifier

const ELM_COMMANDS = {
  RESET: 'ATZ',
  ECHO_OFF: 'ATE0',
  LINEFEEDS_OFF: 'ATL0',
  SPACES_OFF: 'ATS0',
  HEADERS_ON: 'ATH1', // Headers usually needed for detection
  HEADERS_OFF: 'ATH0',
  SET_PROTOCOL_AUTO: 'ATSP0',
  SET_PROTOCOL_PREFIX: 'ATSP',
  GET_PROTOCOL_NUM: 'ATDPN',
  ADAPTIVE_TIMING_OFF: 'ATAT0',
  ADAPTIVE_TIMING_AUTO: 'ATAT1', // Or ATAT2 for more aggressive
  SET_TIMEOUT: 'ATST', // Followed by hex value (e.g., ATST64 for 100ms)
  PROTOCOL_CLOSE: 'ATPC',
  READ_VOLTAGE: 'ATRV', // Good initial check
  MEMORY_OFF: 'ATM0', // Disable memory
  ALLOW_LONG: 'ATAL', // Allow long messages
  DESCRIBE_PROTO: 'ATDP', // Describe current protocol
  TRY_PROTO: 'ATTP', // Try protocol number
};

// Protocol priorities

// Simplified priority order - focusing on common CAN protocols first
const PROTOCOL_TRY_ORDER: ElmProtocols[] = [
  ElmProtocols.ISO_15765_4_CAN_11B_500K, // 6
  ElmProtocols.ISO_15765_4_CAN_11B_250K, // 8
  ElmProtocols.ISO_15765_4_CAN_29B_500K, // 7
  ElmProtocols.ISO_15765_4_CAN_29B_250K, // 9
  ElmProtocols.ISO_14230_4_KWP_FAST, // 5
  ElmProtocols.ISO_9141_2, // 3
  ElmProtocols.ISO_14230_4_KWP, // 4
  ElmProtocols.SAE_J1850_PWM, // 1
  ElmProtocols.SAE_J1850_VPW, // 2
  // J1939 and User protocols are less common for standard diagnostics
];

// Response patterns indicating errors or specific states
const RESPONSE_ERRORS = [
  '?', // ELM indicates syntax error or unknown command
  'NO DATA',
  'ERROR', // General ELM error
  'UNABLE TO CONNECT',
  'STOPPED',
  'BUS INIT', // Often followed by : ERROR
  'BUS ERROR',
  'CAN ERROR',
  'DATA ERROR',
  'BUFFER FULL',
  'FB ERROR', // Feedback error
];

const TEST_COMMAND_PID = '0100'; // Command to request supported PIDs (Mode 01, PID 00)

// --- Interfaces ---

interface ElmEcuConnectorOptions {
  /** Function to send a command and receive a response. */
  sendCommand: (command: string, timeout?: number) => Promise<string | null>;
  /** Logging function. */
  log: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: unknown, // Use unknown instead of any
  ) => void;
  /** Optional callback for status changes. */
  onStatusChange?: (status: ProtocolStatus) => void;
  /** Optional callback when a protocol is detected. */
  onProtocolDetected?: (protocol: ElmProtocols) => void;
  /** Optional maximum retries for critical operations */
  maxRetries?: number;
  /** Optional command timeout */
  commandTimeout?: number;
}

// Re-add AdaptiveTiming interface definition
interface AdaptiveTiming {
  mode: 0 | 1 | 2; // 0=Off, 1=Auto1, 2=Auto2
  currentDelay: number;
}

// Remove unused EcuInfo interface
/*
interface EcuInfo {
  address: string;
  // Potentially add more info here later if needed, e.g., CAN format
}
*/

// --- Utility Functions (Internal) ---

const _delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const _cleanResponse = (response: string | null): string => {
  if (!response) return '';

  // Remove prompt, whitespace, null chars
  let cleaned = response
    .replace(/>$/, '')
    .replace(/[\s\r\n\0]/g, '')
    .toUpperCase()
    .trim();

  // Remove the "62" suffix that appears in all responses
  cleaned = cleaned.replace(/62[?OK]*$/, '');

  // Remove command echo if present
  // e.g. "ATZ62" -> "" or "0100SEARCHING..." -> "SEARCHING..."
  const multiLineResponses = cleaned.split('\r').map(line => line.trim());
  if (multiLineResponses.length > 1) {
    // Take all lines except the first (command echo)
    cleaned = multiLineResponses.slice(1).join('');
  }

  return cleaned;
};

// Simplified priority order - focusing on common CAN protocols first

export class ElmEcuConnector {
  private readonly sendCommand: (
    command: string,
    timeout?: number,
  ) => Promise<string | null>;
  private readonly log: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: unknown, // Use unknown instead of any
  ) => void;
  private readonly onStatusChange?: (status: ProtocolStatus) => void;
  private readonly onProtocolDetected?: (protocol: ElmProtocols) => void;
  private readonly maxRetries: number;
  private readonly commandTimeout: number;
  private textDecoder: TextDecoder;

  private status: ProtocolStatus = ProtocolStatus.UNDEFINED;
  private currentProtocol: ElmProtocols | null = null;
  private ecuAddresses = new Set<string>();
  private selectedEcuAddress: string | null = null;
  private lastError: Error | null = null;
  private adaptiveTiming: AdaptiveTiming = {
    mode: 1,
    currentDelay: COMMAND_DELAY_MS,
  };
  private isConnecting: boolean = false; // Track if a connection attempt is in progress

  constructor(options: ElmEcuConnectorOptions) {
    this.sendCommand = options.sendCommand;
    this.log = options.log;
    this.onStatusChange = options.onStatusChange;
    this.onProtocolDetected = options.onProtocolDetected;
    this.maxRetries = options.maxRetries ?? 3;
    this.commandTimeout = options.commandTimeout ?? DEFAULT_TIMEOUT_MS;
    this.textDecoder = new TextDecoder('utf-8'); // Assuming UTF-8

    this._updateStatus(ProtocolStatus.DISCONNECTED);
    this.log('info', 'ElmEcuConnector initialized');
  }

  /**
   * Attempts to connect to the ECU by initializing the ELM device and detecting the protocol.
   * @returns {Promise<boolean>} True if connection and protocol detection were successful, false otherwise.
   */
  async connectToECU(): Promise<boolean> {
    this.log('info', 'Starting ECU connection process...');
    this._resetState();
    this._updateStatus(ProtocolStatus.INITIALIZING);

    return new Promise((resolve, reject) => {
      (async () => {
        try {
          // 1. Initial Check (e.g., send CR or ATZ to see if we get *anything*)
          const initialResponse = await this._sendCommandInternal(
            '\r',
            RESET_DELAY_MS,
          ); // Sending CR often wakes ELM
          if (initialResponse === null) {
            this.log('warn', 'No initial response from device. Trying ATZ.');
            const resetResponse = await this._sendCommandInternal(
              ELM_COMMANDS.RESET,
              RESET_DELAY_MS,
            );
            if (resetResponse === null) {
              throw new Error(
                'Device not responding to initial commands (CR, ATZ)',
              );
            }
          }

          // Check for Demo Device explicitly if applicable
          // (Based on the original code, this check happened on first command)
          // You might need to adapt this check based on how your demo device identifies itself
          if (initialResponse?.includes(DEMO_DEVICE_ID)) {
            this.log('info', 'Demo device detected.');
            this._updateStatus(ProtocolStatus.DEMO_MODE);
            this.currentProtocol = ElmProtocols.AUTO; // Or a specific demo protocol
            return resolve(true); // Success in demo mode
          }

          // 2. Reset the ELM device
          const resetResponse = await this._sendCommandInternal(
            ELM_COMMANDS.RESET,
            RESET_DELAY_MS,
          );
          // --- MODIFICATION START ---
          // Be more lenient: Fail only on null response or critical communication failure.
          // The _sendCommandInternal already throws on COMMAND_FAILED.
          // Allow any other response (like ATZ62...) as potential success.
          if (resetResponse === null) {
            // --- MODIFICATION END ---
            // Check if it's the specific COMMAND_FAILED error (already handled by throw in _sendCommandInternal)
            // if (this.status === ProtocolStatus.COMMAND_FAILED) { ... } // This check is likely redundant now

            // Log the actual response if it wasn't null but considered an error (no longer considered error here)
            // const responseDetails = resetResponse ? `Response: ${resetResponse.trim()}` : 'No response';
            throw new Error(
              `Failed to reset ELM device (ATZ). No response received.`, // Modified error message
            );
          }
          // If we got *any* non-null response, consider reset successful
          this.log(
            'debug',
            `ELM device reset successful (ATZ response received: ${resetResponse.trim()})`,
          );
          await _delay(RESET_DELAY_MS); // Crucial delay after reset

          // 3. Initialize ELM settings
          if (!(await this._initializeElm())) {
            throw new Error('Failed to initialize ELM settings');
          }
          this.log('debug', 'ELM settings initialized');

          // 4. Detect Protocol
          this._updateStatus(ProtocolStatus.DETECTING_PROTOCOL);
          const detectedProtocol = await this._detectProtocol(); // Calls helpers internally

          if (detectedProtocol !== null) {
            this.currentProtocol = detectedProtocol;
            this.log(
              'info',
              `Protocol detected: ${this.getProtocolDescription()} (ID: ${this.currentProtocol})`,
            );
            // Correct status update:
            this._updateStatus(ProtocolStatus.CONNECTED); // Use locally defined ProtocolStatus
            resolve(true);
          } else {
            throw new Error('Failed to detect a valid OBD protocol');
          }
        } catch (error: unknown) {
          // Use unknown instead of any
          this.log('error', 'ECU connection process failed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          this.lastError =
            error instanceof Error ? error : new Error(String(error));
          if (this.status !== ProtocolStatus.COMMAND_FAILED) {
            this._updateStatus(ProtocolStatus.ERROR);
          }
          await this.disconnect();
          reject(error);
        }
      })(); // Immediately invoke the async function
    });
  }

  /**
   * Gets the currently detected protocol number.
   */
  getCurrentProtocol(): ElmProtocols | null {
    return this.currentProtocol;
  }

  /**
   * Gets the description of the currently detected protocol.
   */
  getProtocolDescription(): string {
    return this.currentProtocol !== null
      ? (ELM_PROTOCOL_DESCRIPTIONS[this.currentProtocol] ?? 'Unknown Protocol')
      : 'No protocol detected';
  }

  /**
   * Gets the current status of the connector.
   */
  getStatus(): ProtocolStatus {
    return this.status;
  }

  /**
   * Gets the set of detected ECU addresses (if any).
   */
  getEcuAddresses(): Set<string> {
    return this.ecuAddresses;
  }

  /**
   * Resets the connector state and attempts to close the protocol on the device.
   */
  async disconnect(): Promise<void> {
    this.log('info', 'Disconnecting...');
    try {
      // Try to close the protocol on the ELM device
      await this._sendCommandInternal(
        ELM_COMMANDS.PROTOCOL_CLOSE,
        COMMAND_DELAY_MS,
      );
    } catch (error) {
      this.log(
        'warn',
        'Failed to send protocol close command during disconnect',
        error,
      );
    } finally {
      this._resetState();
      this._updateStatus(ProtocolStatus.DISCONNECTED);
      this.log('info', 'Disconnected.');
    }
  }

  // --- Private Helper Methods ---

  private _updateStatus(newStatus: ProtocolStatus): void {
    if (this.status !== newStatus) {
      const oldStatus = this.status;
      this.status = newStatus;
      this.log('debug', `Status changed: ${oldStatus} -> ${newStatus}`);
      this.onStatusChange?.(newStatus);
    }
  }

  private _resetState(): void {
    this.currentProtocol = null;
    this.ecuAddresses.clear();
    this.selectedEcuAddress = null;
    this.lastError = null;
    // Don't reset status here, it's managed explicitly
  }

  /** Wrapper for sendCommand dependency to handle logging and basic checks */
  private async _sendCommandInternal(
    command: string,
    delayAfterMs: number = COMMAND_DELAY_MS,
  ): Promise<string | null> {
    this.log('debug', `Sending command: ${command}`);
    try {
      const response = await this.sendCommand(command, this.commandTimeout);
      const cleaned = _cleanResponse(response); // Clean immediately for logging/checks
      this.log(
        'debug',
        `Received response: [${response?.trim() ?? 'null'}] (Cleaned: [${cleaned}])`,
      );

      if (response === null) {
        this.log('warn', `No response received for command: ${command}`);
        return null;
      }

      // Check for critical communication failure reported by the underlying sendCommand
      if (response === 'COMMAND_FAILED') {
        this.log(
          'error',
          `Critical communication failure reported for command: ${command}`,
        );
        this._updateStatus(ProtocolStatus.COMMAND_FAILED);
        throw new Error(
          `Critical communication failure on command: ${command}`,
        ); // Propagate critical failure
      }

      await _delay(delayAfterMs); // Apply delay *after* receiving response
      return response; // Return the raw response
    } catch (error: unknown) {
      // Use unknown instead of any
      // Don't log again if it's the COMMAND_FAILED error we just threw
      if (this.status !== ProtocolStatus.COMMAND_FAILED) {
        this.log('error', `Error sending command: ${command}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Re-throw the error to be handled by the calling function
      throw error;
    }
  }

  /** Executes a command and checks for a basic 'OK' response */
  private async _executeCommand(
    command: string,
    delayAfterMs: number = COMMAND_DELAY_MS,
  ): Promise<boolean> {
    const response = await this._sendCommandInternal(command, delayAfterMs);
    // ELM often responds with the command itself before OK when echo is off initially
    // Be lenient and check if the cleaned response *ends* with OK
    const cleaned = _cleanResponse(response);
    if (cleaned.endsWith('OK')) {
      return true;
    } else if (response === null) {
      this.log('warn', `Command ${command} received no response.`);
      return false; // Treat no response as failure here
    } else if (this._isErrorResponse(response)) {
      this.log(
        'warn',
        `Command ${command} received error response: ${response.trim()}`,
      );
      return false;
    } else {
      // Sometimes ELM just sends the prompt > after certain AT commands
      // Be lenient and consider empty response as success for AT commands
      if (cleaned === '') return true; // Empty response often implies OK for AT commands
      this.log(
        'warn',
        `Command ${command} received unexpected response: ${response.trim()}`,
      );
      // Consider returning true here if the command doesn't *require* an OK (like ATH0)
      return false; // Default to false if not explicitly OK or known good state
    }
  }

  private _isErrorResponse(response: string | null): boolean {
    if (!response) return false;
    const cleaned = _cleanResponse(response);

    // If it contains "OK", it's not an error regardless of other content
    if (cleaned.includes('OK')) {
      return false;
    }

    // Ignore "62?" responses as they are normal for this adapter
    if (cleaned.endsWith('62?') || cleaned.endsWith('62OK')) {
      return false;
    }

    // Allow responses ending in "62" for AT commands
    if (cleaned.startsWith('AT') && cleaned.endsWith('62')) {
      return false;
    }

    // Check for known error strings
    for (const errorStr of RESPONSE_ERRORS) {
      // Exact match or as part of response (after removing 62 suffix)
      const withoutSuffix = cleaned.replace(/62[?OK]*$/, '');
      if (withoutSuffix === errorStr || withoutSuffix.includes(errorStr)) {
        // Exception: Don't treat single "?" as error during init
        if (errorStr === '?' && withoutSuffix === '?') {
          return false;
        }
        return true;
      }
    }

    return false;
  }

  private _isValidDataResponse(response: string | null): boolean {
    if (!response) return false;
    if (this._isErrorResponse(response)) return false;

    const cleaned = _cleanResponse(response);

    // Empty response isn't valid data
    if (cleaned === '' || cleaned === 'OK') return false;

    // Handle "62" suffixed responses
    let dataToCheck = cleaned.replace(/62[?OK]*$/, '');
    dataToCheck = dataToCheck.replace(/^SEARCHING\.\.\./, '');

    // For PID responses, check hex data validity
    if (dataToCheck.startsWith('41')) {
      // Mode 01 responses start with 41
      const hexData = dataToCheck.substring(2); // Remove 41 prefix
      return /^[0-9A-F]+$/.test(hexData);
    }

    // For other responses, check if it's a valid hex string
    const hasHexData = /^[0-9A-F]+$/.test(dataToCheck);
    return (
      hasHexData || dataToCheck.includes('OK') || dataToCheck.endsWith('62')
    );
  }

  private async _detectProtocol(): Promise<ElmProtocols | null> {
    // Try auto protocol first
    let detected = await this._tryAutoProtocol();
    if (detected !== null) {
      return detected;
    }

    // If auto fails, try each protocol with retries
    for (const protocol of PROTOCOL_TRY_ORDER) {
      for (let retry = 0; retry < 3; retry++) {
        detected = await this._trySpecificProtocol(protocol);
        if (detected !== null) {
          return detected;
        }
        await _delay(PROTOCOL_SWITCH_DELAY_MS);
      }
    }

    return null;
  }

  private async _tryAutoProtocol(): Promise<ElmProtocols | null> {
    this.log('info', 'Attempting automatic protocol detection...');

    if (!(await this._setProtocol(ElmProtocols.AUTO))) {
      return null;
    }

    await _delay(PROTOCOL_INIT_DELAY_MS);

    // Try to get protocol description
    const descResponse = await this._sendCommandInternal(
      ELM_COMMANDS.DESCRIBE_PROTO,
    );
    if (descResponse) {
      this.log('debug', `Protocol description: ${descResponse.trim()}`);
    }

    // Test communication
    const testResponse = await this._sendCommandInternal(TEST_COMMAND_PID);
    if (this._isValidDataResponse(testResponse)) {
      return await this._checkProtocolNumber();
    }

    return null;
  }

  private async _trySpecificProtocol(
    protocol: ElmProtocols,
  ): Promise<ElmProtocols | null> {
    this.log(
      'info',
      `Trying protocol: ${ELM_PROTOCOL_DESCRIPTIONS[protocol]} (ID: ${protocol})...`,
    );

    // Try both ATSP and ATTP commands with a longer delay
    let success = await this._setProtocol(protocol);
    if (!success) {
      await _delay(PROTOCOL_INIT_DELAY_MS);
      success = await this._tryProtocol(protocol);
      if (!success) return null;
    }

    await _delay(PROTOCOL_INIT_DELAY_MS);

    // Try PID request multiple times
    for (let attempt = 0; attempt < 3; attempt++) {
      const testResponse = await this._sendCommandInternal(TEST_COMMAND_PID);
      if (this._isValidDataResponse(testResponse)) {
        return protocol;
      }
      await _delay(PROTOCOL_TEST_RETRY_DELAY_MS);
    }

    return null;
  }

  private async _initializeElm(): Promise<boolean> {
    this.log('info', 'Initializing ELM settings...');

    // Critical commands that must succeed
    const criticalCommands = [
      ELM_COMMANDS.RESET, // ATZ - Reset
      ELM_COMMANDS.ECHO_OFF, // ATE0
      ELM_COMMANDS.LINEFEEDS_OFF, // ATL0
    ];

    // Optional commands that can fail
    const optionalCommands = [
      ELM_COMMANDS.SPACES_OFF, // ATS0
      ELM_COMMANDS.HEADERS_ON, // ATH1
      ELM_COMMANDS.ADAPTIVE_TIMING_AUTO, // ATAT1
      `${ELM_COMMANDS.SET_TIMEOUT}FF`, // Higher timeout for slow ECUs
    ];

    // Try critical commands with retries
    for (const cmd of criticalCommands) {
      let success = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await this._sendCommandInternal(cmd, RESET_DELAY_MS);
          // Consider any non-null response that isn't an error as success
          if (response !== null && !this._isErrorResponse(response)) {
            success = true;
            break;
          }
          this.log(
            'debug',
            `Critical command ${cmd} attempt ${attempt + 1} got response: ${response}`,
          );
          await _delay(COMMAND_RETRY_DELAY_MS);
        } catch (error) {
          this.log(
            'warn',
            `Critical command ${cmd} attempt ${attempt + 1} failed`,
            error,
          );
          await _delay(COMMAND_RETRY_DELAY_MS);
        }
      }
      if (!success) {
        this.log('error', `Critical command ${cmd} failed all retries`);
        return false;
      }
    }

    // Try optional commands, ignoring failures
    for (const cmd of optionalCommands) {
      try {
        const response = await this._sendCommandInternal(cmd, COMMAND_DELAY_MS);
        if (response !== null) {
          this.log(
            'debug',
            `Optional command ${cmd} responded with: ${response}`,
          );
        }
      } catch (error) {
        this.log('warn', `Optional command ${cmd} failed, continuing`, error);
      }
      // Add small delay between commands
      await _delay(COMMAND_DELAY_MS);
    }

    return true;
  }

  private async _setProtocol(protocol: ElmProtocols): Promise<boolean> {
    const command = `${ELM_COMMANDS.SET_PROTOCOL_PREFIX}${protocol}`;
    try {
      const response = await this._sendCommandInternal(
        command,
        PROTOCOL_SWITCH_DELAY_MS,
      );
      if (response === null) {
        this.log(
          'warn',
          `Set protocol command ${command} received no response.`,
        );
        return false;
      }

      const cleaned = _cleanResponse(response);
      // Success if response includes OK, matches command, or isn't an error
      if (
        cleaned.includes('OK') ||
        cleaned === command ||
        !this._isErrorResponse(response)
      ) {
        this.log('debug', `Set protocol command ${command} successful`);
        return true;
      }
    } catch (error) {
      this.log('error', `Critical error setting protocol ${protocol}`, error);
      return false;
    }
    return false;
  }

  private async _tryProtocol(protocol: ElmProtocols): Promise<boolean> {
    try {
      const command = `${ELM_COMMANDS.TRY_PROTO}${protocol}`;
      const response = await this._sendCommandInternal(
        command,
        PROTOCOL_SWITCH_DELAY_MS,
      );
      if (response === null) {
        return false;
      }
      // Consider success if we get any response that isn't an error
      return !this._isErrorResponse(response);
    } catch (error) {
      this.log('warn', `Error trying protocol ${protocol}`, error);
      return false;
    }
  }

  private async _checkProtocolNumber(): Promise<ElmProtocols | null> {
    try {
      const response = await this._sendCommandInternal(
        ELM_COMMANDS.GET_PROTOCOL_NUM,
      );
      const cleaned = _cleanResponse(response);

      if (cleaned) {
        // Remove potential "62" suffix before parsing
        const withoutSuffix = cleaned.replace(/62[?OK]*$/, '');
        const match = withoutSuffix.match(/A?([0-9A-C])/);

        if (match && match[1]) {
          let protocolId: string | number = match[1];
          if (protocolId === 'A') {
            protocolId = 10;
          } else if (protocolId === 'B') {
            protocolId = 11;
          } else if (protocolId === 'C') {
            protocolId = 12;
          } else {
            protocolId = parseInt(protocolId, 10);
          }

          if (!isNaN(protocolId) && protocolId >= 0 && protocolId <= 12) {
            this.log('debug', `Detected protocol number: ${protocolId}`);
            return protocolId as ElmProtocols;
          }
        }
      }

      this.log(
        'warn',
        `Could not parse protocol number from response: ${response?.trim() ?? 'null'}`,
      );
      return null;
    } catch (error) {
      this.log('error', 'Error checking protocol number', error);
      return null;
    }
  }

  /** Enhanced method to clean response strings */
  private _cleanResponse(response: string | null): string {
    if (!response) return '';

    // Remove prompt, whitespace, null chars
    let cleaned = response
      .replace(/>$/, '')
      .replace(/[\s\r\n\0]/g, '')
      .toUpperCase()
      .trim();

    // Remove the "62" suffix that appears in all responses from this adapter
    cleaned = cleaned.replace(/62[?OK]*$/, '');

    // Remove command echo if present
    // e.g. "ATZ62" -> "" or "0100SEARCHING..." -> "SEARCHING..."
    const multiLineResponses = cleaned.split('\r').map(line => line.trim());
    if (multiLineResponses.length > 1) {
      // Take all lines except the first (command echo)
      cleaned = multiLineResponses.slice(1).join('');
    }

    return cleaned;
  }
}
