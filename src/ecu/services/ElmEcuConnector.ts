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
};

const DEFAULT_TIMEOUT_MS = 5000;
const COMMAND_DELAY_MS = 100; // Basic delay between commands
const RESET_DELAY_MS = 1000; // Delay after ATZ
const PROTOCOL_SET_DELAY_MS = 200; // Delay after ATSP

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
  // Remove prompt, whitespace, null chars, etc.
  return response
    .replace(/>$/, '')
    .replace(/[\s\r\n\0]/g, '')
    .toUpperCase()
    .trim();
};

// --- The Class ---

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
          if (
            !(await this._executeCommand(ELM_COMMANDS.RESET, RESET_DELAY_MS))
          ) {
            throw new Error('Failed to reset ELM device (ATZ)');
          }
          this.log('debug', 'ELM device reset (ATZ OK)');
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

  /** Initializes basic ELM settings */
  private async _initializeElm(): Promise<boolean> {
    this.log('info', 'Initializing ELM settings...');
    const initCommands = [
      ELM_COMMANDS.ECHO_OFF,
      ELM_COMMANDS.LINEFEEDS_OFF,
      ELM_COMMANDS.SPACES_OFF,
      ELM_COMMANDS.HEADERS_ON, // Headers needed for protocol/ECU detection
      ELM_COMMANDS.ADAPTIVE_TIMING_AUTO, // Use adaptive timing
      `${ELM_COMMANDS.SET_TIMEOUT}64`, // Set timeout (e.g., 100ms = 0x64) - adjust as needed
    ];

    for (const cmd of initCommands) {
      // Use _sendCommandInternal directly as _executeCommand might be too strict for init
      const response = await this._sendCommandInternal(cmd);
      if (response === null) {
        this.log(
          'warn',
          `No response during init for command: ${cmd}. Continuing...`,
        );
        // Some ELM clones might not respond reliably to all init commands
        // Decide if this should be a hard failure.
        // return false;
      } else if (this._isErrorResponse(response)) {
        this.log(
          'error',
          `Error response during init for command: ${cmd} -> ${response.trim()}`,
        );
        return false;
      }
      // No need to check for 'OK' explicitly for all init commands
    }
    return true;
  }

  /** Attempts to detect the OBD protocol */
  private async _detectProtocol(): Promise<ElmProtocols | null> {
    this.log(
      'info',
      'Attempting automatic protocol detection (ATSP0 + 0100)...',
    );

    // 1. Try Auto Protocol + 0100
    if (!(await this._setProtocol(ElmProtocols.AUTO))) return null;
    await _delay(PROTOCOL_SET_DELAY_MS);

    const response0100 = await this._sendCommandInternal(TEST_COMMAND_PID);

    if (this._isValidDataResponse(response0100)) {
      this.log(
        'debug',
        `Received valid response for ${TEST_COMMAND_PID} on Auto protocol.`,
      );
      // Now check which protocol was actually used
      const detected = await this._checkProtocolNumber();
      if (detected !== null) {
        this.log(
          'info',
          `Auto-detection successful. Protocol identified as: ${detected}`,
        );
        // Try to detect ECUs from the 0100 response
        await this._handleEcuDetection(response0100);
        return detected;
      } else {
        this.log(
          'warn',
          `Command ${TEST_COMMAND_PID} succeeded, but failed to read protocol number (ATDPN).`,
        );
      }
    } else {
      this.log('warn', `Command ${TEST_COMMAND_PID} failed on Auto protocol.`);
    }

    // 2. If Auto failed, iterate through specific protocols
    this.log(
      'info',
      'Auto-detection failed or inconclusive. Trying specific protocols...',
    );
    for (const protocol of PROTOCOL_TRY_ORDER) {
      this.log(
        'info',
        `Trying protocol: ${ELM_PROTOCOL_DESCRIPTIONS[protocol]} (ID: ${protocol})...`,
      );
      this._updateStatus(ProtocolStatus.DETECTING_PROTOCOL); // Update status for each try

      if (!(await this._setProtocol(protocol))) continue; // Try next if setting fails
      await _delay(PROTOCOL_SET_DELAY_MS);

      // Send test command for this protocol
      const testResponse = await this._sendCommandInternal(TEST_COMMAND_PID);

      if (this._isValidDataResponse(testResponse)) {
        this.log('info', `Protocol ${protocol} seems successful.`);
        // Try to detect ECUs from the response
        await this._handleEcuDetection(testResponse);
        return protocol;
      } else {
        this.log(
          'debug',
          `Protocol ${protocol} failed test command ${TEST_COMMAND_PID}.`,
        );
        // Optionally send ATPC (Protocol Close) before trying the next one
        // await this._sendCommandInternal(ELM_COMMANDS.PROTOCOL_CLOSE);
        // await _delay(COMMAND_DELAY_MS);
      }
    }

    this.log(
      'error',
      'Failed to detect any working protocol after trying all options.',
    );
    return null;
  }

  /** Sends ATDPN to get the current protocol number */
  private async _checkProtocolNumber(): Promise<ElmProtocols | null> {
    const response = await this._sendCommandInternal(
      ELM_COMMANDS.GET_PROTOCOL_NUM,
    );
    const cleaned = _cleanResponse(response);

    if (cleaned) {
      const match = cleaned.match(/A?([0-9A-C])/);
      if (match && match[1]) {
        let protocolId: string | number = match[1];
        // Fix syntax error: Add parentheses around the condition
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
          this.log('debug', `ATDPN reports protocol: ${protocolId}`);
          return protocolId as ElmProtocols;
        }
      }
    }
    this.log(
      'warn',
      `Could not parse protocol number from ATDPN response: ${response?.trim() ?? 'null'}`,
    );
    return null;
  }

  /** Sets the protocol using ATSP command */
  private async _setProtocol(protocol: ElmProtocols): Promise<boolean> {
    const command = `${ELM_COMMANDS.SET_PROTOCOL_PREFIX}${protocol}`;
    return await this._executeCommand(command, PROTOCOL_SET_DELAY_MS);
  }

  private _isErrorResponse(response: string | null): boolean {
    if (!response) return true; // No response is an error in context
    const cleaned = _cleanResponse(response);
    // Check against known error strings
    for (const errorStr of RESPONSE_ERRORS) {
      if (cleaned.includes(errorStr)) {
        return true;
      }
    }
    return false;
  }

  private _isValidDataResponse(response: string | null): boolean {
    if (!response) return false;
    if (this._isErrorResponse(response)) return false;
    const cleaned = _cleanResponse(response);
    if (cleaned === 'OK' || cleaned === '') return false;
    if (cleaned.match(/^(?:[0-9A-F]{2,}\s)?(41|43|44|47|49|4A)/)) {
      return true;
    }
    if (/^[0-9A-F\s]+$/.test(cleaned) && cleaned.length > 2) {
      return true;
    }
    return false;
  }

  private async _handleEcuDetection(response: string | null): Promise<void> {
    if (!response || !this._isValidDataResponse(response)) {
      return;
    }
    this._updateStatus(ProtocolStatus.ECU_DETECTING);
    const lines = response.trim().split(/[\r\n]+/);
    const detected = new Set<string>();
    lines.forEach(line => {
      const cleanedLine = _cleanResponse(line);
      const can11Match = cleanedLine.match(/^(7E[8-F])/);
      const can29Match = cleanedLine.match(/^(18DA[0-9A-F]{2}[0-9A-F]{2})/);
      if (can11Match && can11Match[1]) {
        detected.add(can11Match[1]);
        this.log('debug', `Detected 11-bit ECU header: ${can11Match[1]}`);
      } else if (can29Match && can29Match[1]) {
        detected.add(can29Match[1]);
        this.log('debug', `Detected 29-bit ECU header: ${can29Match[1]}`);
      }
    });
    if (detected.size > 0) {
      this.ecuAddresses = detected;
      const firstValue = detected.values().next().value;
      this.selectedEcuAddress = firstValue !== undefined ? firstValue : null;
      if (this.selectedEcuAddress) {
        await this.log(
          'info',
          `ECU address ${this.selectedEcuAddress} selected for communication.`,
        );
        this._updateStatus(ProtocolStatus.ECU_DETECTED);
      } else {
        this.log(
          'warn',
          'Detected ECU headers but could not select a primary address.',
        );
      }
    } else {
      this.log(
        'warn',
        'Valid data response received, but no ECU headers detected.',
      );
    }
  }
}

// --- Definitions outside the class (Interfaces ONLY) ---
// Ensure ElmEcuConnectorOptions is defined here if not imported
interface ElmEcuConnectorOptions {
  sendCommand: (command: string, timeout?: number) => Promise<string | null>;
  log: (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    data?: unknown, // Use unknown instead of any
  ) => void;
  onStatusChange?: (status: ProtocolStatus) => void;
  onProtocolDetected?: (protocol: ElmProtocols) => void;
  maxRetries?: number;
  commandTimeout?: number;
}

// Remove unused EcuInfo interface
/*
interface EcuInfo {
  address: string;
  // Potentially add more info here later if needed, e.g., CAN format
}
*/

// Remove unused AdaptiveTiming interface if not used elsewhere
/*
interface AdaptiveTiming {
  mode: 0 | 1 | 2; // 0=Off, 1=Auto1, 2=Auto2
  currentDelay: number;
}
*/
