import { log } from '../../utils/logger';
import { RESPONSE_KEYWORDS, PROTOCOL } from '../utils/constants'; // Removed DELAYS_MS, ELM_COMMANDS // Added PROTOCOL
import { isResponseError } from '../utils/helpers';
import { bytesToHex } from '../utils/ecuUtils';
import { ecuStore } from '../context/ECUStore';
import type {
  SendCommandFunction,
  SendCommandRawFunction,
  ChunkedResponse,
  VINConstants,
  ResponseValidation,
  CANConfig,
  // ECUStoreState, // No longer needed directly in tryFlowControl signature
  CommandConfig,
} from './types'; // Adjusted imports

// Constants for VIN retrieval - Refined based on JS analysis
const VIN_CONSTANTS: VINConstants = {
  COMMAND: '0902',
  TIMEOUT: 5000, // Increased timeout slightly
  RETRIES: 3,
  DELAYS: {
    INIT: 250, // Slightly reduced init delay
    COMMAND: 150, // Increased command delay slightly
    PROTOCOL: 200,
    ADAPTIVE_BASE: 100, // Base delay, will be adjusted by adaptive timing if enabled
  },
  // Split init sequence
  INIT_SEQUENCE_PRE_PROTOCOL: [
    // ATZ handled conditionally based on connection status
    { cmd: 'ATE0', delay: 100 }, // Echo off
    { cmd: 'ATL0', delay: 100 }, // Linefeeds off
    { cmd: 'ATS0', delay: 100 }, // Spaces off
    { cmd: 'ATH1', delay: 100 }, // Headers ON (Crucial!)
    { cmd: 'ATCAF1', delay: 100 }, // Formatting ON (Good for CAN)
    { cmd: 'ATST64', delay: 100 }, // Set timeout (e.g., ~100ms * 4 = 400ms) - Adjust if needed
  ],
  INIT_SEQUENCE_POST_PROTOCOL: [
    // Adaptive timing is handled separately
    // Protocol specific commands (like filters) are handled within initializeDevice
  ],
  CAN_CONFIGS: [
    {
      desc: '11-bit Standard',
      header: '7DF', // Default broadcast header
      receiveAddr: '7E8', // Default ECU response address
      flowAddr: '7E0', // Default flow control address
      canType: '11bit',
      adaptiveTimingMode: 2, // Prefer ATAT2 for CAN
      commands: [
        // Commands specific to this config AFTER protocol is set
        { cmd: 'ATCRA7E8', delay: 100 }, // Filter for default ECU response
        { cmd: 'ATCF7E8', delay: 100 }, // Filter mask (optional, often matches CRA)
        // Flow control commands moved to tryFlowControl
      ],
    },
    {
      desc: '29-bit Standard',
      header: '18DB33F1', // Default broadcast header
      receiveAddr: '18DAF110', // Default ECU response address
      flowAddr: '18DA10F1', // Default flow control address
      canType: '29bit',
      adaptiveTimingMode: 2, // Prefer ATAT2 for CAN
      commands: [
        { cmd: 'ATCRA18DAF110', delay: 100 },
        { cmd: 'ATCF18DAF110', delay: 100 },
        // Flow control commands moved to tryFlowControl
      ],
    },
  ],
  FLOW_CONTROL_CONFIGS: [
    { fcsh: '', fcsd: '300000', fcsm: '1', desc: 'Standard Mode 1' },
    { fcsh: '', fcsd: '300000', fcsm: '0', desc: 'Standard Mode 0' },
    { fcsh: '', fcsd: '300008', fcsm: '1', desc: 'Extended Wait Mode 1' }, // 8ms separation
    { fcsh: '', fcsd: '300100', fcsm: '1', desc: 'Block Size 1 Mode 1' }, // Block size 1
  ],
} as const;

export class VINRetriever {
  private sendCommand: SendCommandFunction;
  private sendCommandRaw: SendCommandRawFunction;
  private currentAdaptiveDelay: number;
  private currentATMode: 0 | 1 | 2;

  constructor(
    sendCommand: SendCommandFunction,
    sendCommandRaw: SendCommandRawFunction,
  ) {
    if (!sendCommand) {
      throw new Error(
        'VINRetriever requires the standard sendCommand function.',
      );
    }
    if (!sendCommandRaw) {
      throw new Error('VINRetriever requires the sendCommandRaw function.');
    }
    this.sendCommand = sendCommand;
    this.sendCommandRaw = sendCommandRaw;
    this.currentAdaptiveDelay = VIN_CONSTANTS.DELAYS.ADAPTIVE_BASE; // Initialize delay
    this.currentATMode = 0; // Default to AT off
  }

  // Use adaptive delay if AT mode is enabled
  private async delay(ms: number): Promise<void> {
    const delayToUse = this.currentATMode > 0 ? this.currentAdaptiveDelay : ms;
    // Add a small minimum delay regardless
    const finalDelay = Math.max(delayToUse, 50);
    log.debug(
      `[VINRetrieverLIB] Delaying for ${finalDelay}ms (AT Mode: ${this.currentATMode}, Base: ${ms}, Current AT Delay: ${this.currentAdaptiveDelay})`,
    );
    return new Promise<void>(resolve => {
      setTimeout(resolve, finalDelay);
    });
  }

  // Simple adaptive timing adjustment (basic version)
  private adjustAdaptiveTiming(success: boolean) {
    if (this.currentATMode === 0) return; // No adjustment if AT is off

    const increment = 20; // How much to increase delay on failure
    const decrement = 10; // How much to decrease delay on success
    const minDelay = 50;
    const maxDelay = 500;

    if (success) {
      this.currentAdaptiveDelay = Math.max(
        minDelay,
        this.currentAdaptiveDelay - decrement,
      );
    } else {
      this.currentAdaptiveDelay = Math.min(
        maxDelay,
        this.currentAdaptiveDelay + increment,
      );
    }
    log.debug(
      `[VINRetrieverLIB] Adaptive timing adjusted. Success: ${success}, New Delay: ${this.currentAdaptiveDelay}`,
    );
  }

  /**
   * Safely convert bytes to hex string using utility function.
   */
  private bytesToHex(bytes: Uint8Array | number[] | null | undefined): string {
    if (!bytes) return '';
    // Ensure it's Uint8Array or number[] before passing
    const validBytes =
      bytes instanceof Uint8Array || Array.isArray(bytes) ? bytes : [];
    return bytesToHex(validBytes);
  }

  /**
   * Convert hex string to ASCII, filtering for valid VIN characters.
   */
  private hexToAscii(hex: string): string {
    let str = '';
    // Ensure hex string length is even, remove non-hex chars first
    const cleanHex = hex.replace(/[^0-9A-F]/gi, '');
    const finalHex =
      cleanHex.length % 2 !== 0 ? cleanHex.slice(0, -1) : cleanHex;

    for (let i = 0; i < finalHex.length; i += 2) {
      try {
        const charCode = parseInt(finalHex.substring(i, i + 2), 16);
        if (isNaN(charCode)) continue;
        // Filter for standard printable ASCII relevant to VIN (alphanumeric)
        if (
          (charCode >= 48 && charCode <= 57) || // 0-9
          (charCode >= 65 && charCode <= 90) // A-Z (uppercase)
          // (charCode >= 97 && charCode <= 122) // a-z (allow lowercase if needed, but VINs are usually uppercase)
        ) {
          str += String.fromCharCode(charCode);
        }
      } catch (e) {
        log.warn(
          `[VINRetrieverLIB] Error parsing hex pair: ${finalHex.substring(i, i + 2)}`,
          e,
        );
      }
    }
    // Only return if it looks like a potential VIN start, trim spaces added by String.fromCharCode maybe?
    return str.trim();
  }

  /**
   * Validate VIN format (17 alphanumeric chars, excluding I, O, Q).
   */
  private isValidVIN(vin: string): boolean {
    return /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin);
  }

  /**
   * Check response chunks for errors, returning raw/clean strings.
   * Now uses rawResponse (array of byte arrays).
   */
  private checkResponseForErrors(
    rawResponseBytes: number[][] | null | undefined, // Match updated type
  ): ResponseValidation {
    // ... existing implementation ...
    // Ensure rawResponseBytes is handled correctly with the updated type
    const result: ResponseValidation = {
      error: null,
      rawString: '',
      cleanHex: '',
    };

    if (!rawResponseBytes || rawResponseBytes.length === 0) {
      result.error = 'No response received';
      return result;
    }

    try {
      let combinedBytes: number[] = [];
      for (const byteArray of rawResponseBytes) {
        // Convert Uint8Array to number[] if necessary - This part might be redundant now if rawResponse is number[][]
        // Keep it for safety in case chunks still contain Uint8Array
        const numbers =
          byteArray instanceof Uint8Array ? Array.from(byteArray) : byteArray;
        if (Array.isArray(numbers)) {
          combinedBytes = combinedBytes.concat(numbers);
        } else {
          log.warn(
            '[VINRetrieverLIB] Unexpected format in rawResponseBytes:',
            byteArray,
          );
        }
      }
      result.rawString = String.fromCharCode(...combinedBytes);
    } catch (e) {
      log.error(
        '[VINRetrieverLIB] Error combining/decoding rawResponseBytes',
        e,
      );
      result.error = 'Byte array processing error';
      return result;
    }

    // Basic cleaning for error keyword checking
    const basicCleaned = result.rawString
      .replace(/[>\r\n]/g, ' ') // Replace prompt/newlines with space
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    // More thorough cleaning for hex processing
    result.cleanHex = basicCleaned
      .replace(/[^0-9A-F]/gi, '') // Keep only hex characters
      .toUpperCase();

    // --- Specific Error Checks ---
    if (isResponseError(basicCleaned)) {
      // Use helper for common ELM errors
      if (basicCleaned.toUpperCase().includes(RESPONSE_KEYWORDS.TIMEOUT))
        result.error = 'Timeout';
      else if (
        basicCleaned
          .toUpperCase()
          .includes(RESPONSE_KEYWORDS.BUFFER_FULL.replace(/\s/g, ''))
      )
        result.error = 'Buffer Full';
      else if (
        basicCleaned
          .toUpperCase()
          .includes(RESPONSE_KEYWORDS.NO_DATA.replace(/\s/g, ''))
      )
        result.error = 'No Data';
      else if (
        basicCleaned
          .toUpperCase()
          .includes(RESPONSE_KEYWORDS.UNABLE_TO_CONNECT.replace(/\s/g, ''))
      )
        result.error = 'Unable to Connect';
      else if (
        basicCleaned
          .toUpperCase()
          .includes(RESPONSE_KEYWORDS.CAN_ERROR.replace(/\s/g, ''))
      )
        result.error = 'CAN Error';
      else if (
        basicCleaned
          .toUpperCase()
          .includes(RESPONSE_KEYWORDS.BUS_ERROR.replace(/\s/g, ''))
      )
        result.error = 'Bus Error';
      else if (basicCleaned.trim() === RESPONSE_KEYWORDS.QUESTION_MARK)
        result.error = 'Command Error (?)';
      // General Negative Response check (7F XX XX) - Check on the clean hex
      else if (result.cleanHex.startsWith('7F')) {
        const modeEcho = result.cleanHex.substring(2, 4); // 7F[XX]yy
        const nrc = result.cleanHex.substring(4, 6); // 7Fxx[YY]
        result.error = `Negative Response (Mode Echo: ${modeEcho}, NRC: ${nrc})`;
        // Add specific log for NRC
        log.warn(
          `[VINRetrieverLIB] Received Negative Response (7F). Mode Echo: ${modeEcho}, NRC: ${nrc}`,
        );
      } else result.error = `General Error (${basicCleaned})`;
    }
    // Check for empty response (just prompt or whitespace)
    else if (basicCleaned === '' || basicCleaned === RESPONSE_KEYWORDS.PROMPT) {
      result.error = 'Empty response';
    }
    // Additional check for potential non-7F Negative Responses, specifically NRC 31
    // Example: UF 01 31 or similar patterns where the 3rd byte is 31
    // This assumes a structure like [Header?] [Mode Echo] [PID Echo] [NRC]
    // Check if cleanHex has at least 6 chars and the 5th/6th chars are '31'
    // And ensure it doesn't start with '4902' (positive response)
    else if (
      result.cleanHex.length >= 6 &&
      result.cleanHex.substring(4, 6) === '31' &&
      !result.cleanHex.includes('4902')
    ) {
      const potentialModeEcho = result.cleanHex.substring(0, 2); // Might not be standard echo
      const potentialPidEcho = result.cleanHex.substring(2, 4); // Might not be standard echo
      const nrc = '31';
      result.error = `Potential Negative Response (NRC: ${nrc})`;
      log.warn(
        `[VINRetrieverLIB] Received Potential Negative Response (NRC: ${nrc}). Pattern: ${potentialModeEcho} ${potentialPidEcho} ${nrc}. Full Hex: ${result.cleanHex}`,
      );
    }

    log.debug('[VINRetrieverLIB] checkResponseForErrors result:', {
      error: result.error,
      cleanHexLength: result.cleanHex.length,
    });
    return result;
  }

  private isValidCommandResponse(response: string | null): boolean {
    if (!response) {
        log.debug('[VINRetrieverLIB] isValidCommandResponse: Received null response.');
        return false;
    }

    // Aggressive cleaning: remove prompt, trim whitespace thoroughly
    const cleaned = response.replace(/>/g, '').trim().toUpperCase();
    log.debug(`[VINRetrieverLIB] isValidCommandResponse: Evaluating cleaned response: "${cleaned}" (Original: "${response}")`);


    // Check for specific error patterns first
    if (
      cleaned.includes('ERROR') ||
      cleaned.includes('?') || // Command error
      cleaned.startsWith('7F') // Negative response
    ) {
      log.debug(`[VINRetrieverLIB] isValidCommandResponse: Detected error pattern in "${cleaned}". Result: false`);
      return false;
    }

    // Common valid response patterns for AT commands
    const isOk = cleaned.includes('OK');
    // Check if the cleaned response *ends with* '62', potentially after the echoed command
    const endsWith62 = cleaned.endsWith('62');
    const isElm = cleaned.includes('ELM');
    const isEmptyAfterClean = cleaned === ''; // Was only prompt or whitespace

    const isValid = isOk || endsWith62 || isElm || isEmptyAfterClean;

    log.debug(`[VINRetrieverLIB] isValidCommandResponse: Checks for "${cleaned}": isOk=${isOk}, endsWith62=${endsWith62}, isElm=${isElm}, isEmpty=${isEmptyAfterClean}. Result: ${isValid}`);

    return isValid;
  }

  private async executeCommandSequence(
    commands: ReadonlyArray<CommandConfig>,
    failFast: boolean = true, // Add option to fail immediately on invalid response
  ): Promise<boolean> {
    for (const { cmd, delay: baseDelay } of commands) {
      const response = await this.sendCommand(cmd);
      const isValid = this.isValidCommandResponse(response);
      this.adjustAdaptiveTiming(isValid); // Adjust timing based on response validity
      if (!isValid) {
        log.warn( // Changed to warn, but check failFast
          `[VINRetrieverLIB] Command ${cmd} response invalid:`,
          response,
        );
        if (failFast) {
          log.error(
            `[VINRetrieverLIB] Critical command ${cmd} failed. Aborting sequence.`,
          );
          return false; // Make it fatal for critical init steps if failFast is true
        }
      } else {
        log.debug(`[VINRetrieverLIB] Command ${cmd} successful.`);
      }
      await this.delay(baseDelay); // Use the adaptive delay mechanism
    }
    return true;
  }

  private async setupAdaptiveTiming(preferredMode: 0 | 1 | 2): Promise<void> {
    let success = false;
    // Try preferred mode first
    if (preferredMode > 0) {
      const cmd = `ATAT${preferredMode}`;
      log.debug(`[VINRetrieverLIB] Trying adaptive timing mode: ${cmd}`);
      const response = await this.sendCommand(cmd);
      if (this.isValidCommandResponse(response)) {
        this.currentATMode = preferredMode;
        this.currentAdaptiveDelay = VIN_CONSTANTS.DELAYS.ADAPTIVE_BASE; // Reset delay
        log.info(
          `[VINRetrieverLIB] Adaptive timing enabled: Mode ${this.currentATMode}`,
        );
        success = true;
      } else {
        log.warn(
          `[VINRetrieverLIB] Failed to set adaptive timing mode ${preferredMode}`,
        );
      }
    }

    // Fallback to ATAT1 if preferred failed
    if (!success && preferredMode === 2) {
      const cmd = `ATAT1`;
      log.debug(
        `[VINRetrieverLIB] Falling back to adaptive timing mode: ${cmd}`,
      );
      const response = await this.sendCommand(cmd);
      if (this.isValidCommandResponse(response)) {
        this.currentATMode = 1;
        this.currentAdaptiveDelay = VIN_CONSTANTS.DELAYS.ADAPTIVE_BASE;
        log.info(
          `[VINRetrieverLIB] Adaptive timing enabled: Mode ${this.currentATMode}`,
        );
        success = true;
      } else {
        log.warn(`[VINRetrieverLIB] Failed to set adaptive timing mode 1`);
      }
    }

    // Fallback to ATAT0 (off) if all else fails
    if (!success) {
      const cmd = `ATAT0`;
      log.debug(`[VINRetrieverLIB] Falling back to fixed timing: ${cmd}`);
      const response = await this.sendCommand(cmd);
      if (this.isValidCommandResponse(response)) {
        this.currentATMode = 0;
        log.info(`[VINRetrieverLIB] Adaptive timing disabled (fixed timing).`);
      } else {
        log.error(`[VINRetrieverLIB] Failed to disable adaptive timing!`);
      }
    }
    await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);
  }

  private async initializeDevice(): Promise<boolean> {
    log.info('[VINRetrieverLIB] Initializing device for VIN retrieval...');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state: any = ecuStore.getState(); // Use any to bypass type checking
      log.debug('[VINRetrieverLIB] Current ECU State:', state);

      // 1. Check connection status and protocol
      // Handle potential null for activeProtocol
      const currentProtocol = state.activeProtocol;
      if (currentProtocol === null) {
        log.error(
          '[VINRetrieverLIB] Prerequisite failed: Active protocol is null.',
        );
        return false;
      }
      const isCanProtocol = currentProtocol >= 6 && currentProtocol <= 9;
      if (state.status !== 'CONNECTED' || !isCanProtocol) {
        log.error(
          '[VINRetrieverLIB] Prerequisite failed: Not connected or not a CAN protocol.',
          { status: state.status, protocol: currentProtocol },
        );
        return false;
      }

      // 2. Gentle Reset (only if needed? Maybe skip ATZ entirely if already connected)
      // Let's skip ATZ for now to avoid disrupting the connection.
      // If issues persist, we might need `ATZ` but it's risky.

      // 3. Basic ELM Setup (Pre-Protocol) - Fail fast if these fail
      log.debug('[VINRetrieverLIB] Sending pre-protocol init sequence...');
      if (
        !(await this.executeCommandSequence(
          VIN_CONSTANTS.INIT_SEQUENCE_PRE_PROTOCOL,
          true, // Fail fast is true for these critical commands
        ))
      ) {
        log.error('[VINRetrieverLIB] Pre-protocol initialization failed.');
        return false;
      }

      // 4. Set Protocol Explicitly - Fail fast
      const protocolCmd = `ATSP${currentProtocol}`; // Use validated currentProtocol
      log.debug(
        `[VINRetrieverLIB] Setting protocol explicitly: ${protocolCmd}`,
      );
      const spResponse = await this.sendCommand(protocolCmd);
      const isSpValid = this.isValidCommandResponse(spResponse);
      this.adjustAdaptiveTiming(isSpValid);
      if (!isSpValid) {
        log.error(
          `[VINRetrieverLIB] Failed to set protocol ${currentProtocol}. Response: ${spResponse}. Aborting.`,
        );
        return false; // Fail fast
      }
      await this.delay(VIN_CONSTANTS.DELAYS.PROTOCOL);

      // 5. Determine CAN Config based on state
      // Use selectedEcuAddress to infer 11/29 bit if available, otherwise default based on protocol number
      let config: CANConfig | undefined;
      if (state.selectedEcuAddress) {
        config =
          state.selectedEcuAddress.length > 3 // Basic check for 29-bit format like 18DAF110
            ? VIN_CONSTANTS.CAN_CONFIGS.find(c => c.canType === '29bit')
            : VIN_CONSTANTS.CAN_CONFIGS.find(c => c.canType === '11bit');
      } else {
        // Default based on protocol number if no address selected yet
        config =
          currentProtocol === 7 || currentProtocol === 9 // Use validated currentProtocol
            ? VIN_CONSTANTS.CAN_CONFIGS.find(c => c.canType === '29bit')
            : VIN_CONSTANTS.CAN_CONFIGS.find(c => c.canType === '11bit');
      }

      if (!config) {
        log.error(
          `[VINRetrieverLIB] Could not determine CAN configuration for protocol ${currentProtocol}`,
        );
        return false;
      }
      log.debug(`[VINRetrieverLIB] Using CAN config: ${config.desc}`);

      // 6. Setup Adaptive Timing (based on config) - Don't fail fast here
      await this.setupAdaptiveTiming(config.adaptiveTimingMode);

      // 7. Apply Post-Protocol / CAN Specific Init (Filters, etc.) - Fail fast
      log.debug('[VINRetrieverLIB] Sending CAN specific init sequence...');
      // Use the specific commands from the chosen config
      if (!(await this.executeCommandSequence(config.commands, true))) { // Fail fast
        log.error('[VINRetrieverLIB] CAN specific initialization failed.');
        return false;
      }

      // 8. Set Header (using selected address or default from config) - Fail fast
      const headerToSet = state.selectedEcuAddress || config.header;
      const headerCmd = `ATSH${headerToSet}`;
      log.debug(`[VINRetrieverLIB] Setting header: ${headerCmd}`);
      const shResponse = await this.sendCommand(headerCmd);
      const isShValid = this.isValidCommandResponse(shResponse);
      this.adjustAdaptiveTiming(isShValid);
      if (!isShValid) {
        log.error(
          `[VINRetrieverLIB] Failed to set header ${headerToSet}. Response: ${shResponse}. Aborting.`,
        );
        return false; // Fail fast
      }
      await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);

      log.info(
        '[VINRetrieverLIB] Device initialization for VIN retrieval seems successful.',
      );
      return true;
    } catch (error) {
      log.error(
        '[VINRetrieverLIB] Initialization failed with exception:',
        error,
      );
      this.currentATMode = 0; // Ensure AT is off on error
      return false;
    }
  }

  private async sendVINRequest(attempt = 1): Promise<ChunkedResponse | null> {
    log.debug(
      `[VINRetrieverLIB] Sending VIN request (attempt ${attempt}/${VIN_CONSTANTS.RETRIES})`,
    );
    try {
      const response = await this.sendCommandRaw(VIN_CONSTANTS.COMMAND, {
        timeout: VIN_CONSTANTS.TIMEOUT,
      });

      // Basic validation before detailed check
      // Check if rawResponse exists and is not empty
      const hasData = response?.rawResponse && response.rawResponse.some(chunk => chunk.length > 0);
      this.adjustAdaptiveTiming(hasData ?? false); // Adjust timing based on whether *any* data was received

      if (hasData && response.rawResponse) {
        // Add check for rawResponse existence
        const { error, cleanHex } = this.checkResponseForErrors(response.rawResponse); // Get cleanHex too

        // Check if the response is NOT a definite error (like CAN ERROR, BUS ERROR, ?, etc.)
        // Allow 'No Data', 'Timeout', 'Negative Response' as they might be recoverable or expected in some cases before flow control
        const isRecoverableOrNoError = !error ||
                                       error === 'No Data' ||
                                       error === 'Timeout' ||
                                       error.includes('Negative Response') ||
                                       error.includes('Potential Negative Response');

        if (isRecoverableOrNoError) {
           // Also check if we actually got the expected response code (4902) even if errors were flagged
           const hasVINResponseCode = cleanHex.includes('4902');

           if (hasVINResponseCode) {
             log.debug(
               `[VINRetrieverLIB] VIN request attempt ${attempt} got positive response marker (4902). Error status: ${error || 'None'}`,
             );
             return response; // Return response if 4902 is present
           } else if (!error) {
             log.debug(
               `[VINRetrieverLIB] VIN request attempt ${attempt} got response without errors, but no 4902 marker. Hex: ${cleanHex}`,
             );
             // Consider returning response here too, maybe processVINResponse can handle it?
             // For now, let's treat lack of 4902 as failure for standard request.
           } else {
             log.warn(
               `[VINRetrieverLIB] VIN request attempt ${attempt} resulted in recoverable error: ${error}. Hex: ${cleanHex}`,
             );
             // Proceed to retry or flow control
           }
        } else {
          // Definite, non-recoverable error
          log.error(
            `[VINRetrieverLIB] VIN request attempt ${attempt} failed with non-recoverable error: ${error}. Hex: ${cleanHex}`,
          );
          // No retry if it's a definite error like CAN ERROR? Maybe retry anyway? Let's keep retry logic.
        }
      } else {
        log.warn(
          `[VINRetrieverLIB] VIN request attempt ${attempt} got invalid/empty/timeout response.`,
        );
        // Adjust timing already happened based on hasData
      }

      // Retry logic
      if (attempt < VIN_CONSTANTS.RETRIES) {
        await this.delay(VIN_CONSTANTS.DELAYS.INIT); // Use adaptive delay before retry
        return this.sendVINRequest(attempt + 1);
      }

      log.error(
        `[VINRetrieverLIB] VIN request failed after ${VIN_CONSTANTS.RETRIES} attempts.`,
      );
      return null;
    } catch (error) {
      this.adjustAdaptiveTiming(false); // Adjust timing on error
      log.error('[VINRetrieverLIB] VIN request failed with exception:', error);
      // Retry logic for exceptions
      if (attempt < VIN_CONSTANTS.RETRIES) {
        await this.delay(VIN_CONSTANTS.DELAYS.INIT);
        return this.sendVINRequest(attempt + 1);
      }
      return null;
    }
  }

  public async retrieveVIN(): Promise<string | null> {
    log.info('[VINRetrieverLIB] Attempting to retrieve VIN...');
    try {
      // Capture state *before* async operations within retrieveVIN
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const currentState: any = ecuStore.getState(); // Use any to bypass type checking
      const currentProtocol = currentState.activeProtocol;
      const selectedEcuAddress = currentState.selectedEcuAddress;

      log.info(
        JSON.stringify({
          currentProtocol,
          selectedEcuAddress,
          currentState
        })
      );

      if (!(await this.initializeDevice())) {
        log.error(
          '[VINRetrieverLIB] VIN retrieval failed during initialization.',
        );
        return null;
      }

      // Try standard request first (with retries handled internally)
      let response = await this.sendVINRequest();

      // Check if the response is valid *before* trying flow control
      // A valid response here means it contains '4902'
      let needsFlowControl = true;
      if (response?.rawResponse) {
          const { cleanHex } = this.checkResponseForErrors(response.rawResponse);
          if (cleanHex.includes('4902')) {
              log.info('[VINRetrieverLIB] Standard VIN request successful (found 4902).');
              needsFlowControl = false;
          } else {
              log.info('[VINRetrieverLIB] Standard VIN request did not contain 4902, proceeding to flow control.');
          }
      } else {
          log.info('[VINRetrieverLIB] Standard VIN request failed or yielded empty response, proceeding to flow control.');
      }


      // If standard request failed OR didn't contain 4902, try variations with flow control
      if (needsFlowControl) {
        log.info(
          '[VINRetrieverLIB] Trying flow control configurations...',
        );
        // Pass the captured state to tryFlowControl
        response = await this.tryFlowControl(
          currentProtocol,
          selectedEcuAddress,
        );
      }

      // Process the response if we have one
      if (response?.rawResponse) {
        log.debug('[VINRetrieverLIB] Processing final response for VIN...');
        const processedVin = this.processVINResponse(response.rawResponse);
        if (processedVin && this.isValidVIN(processedVin)) {
          log.info(
            `[VINRetrieverLIB] Successfully retrieved VIN: ${processedVin}`,
          );
          return processedVin;
        } else {
          log.warn(
            '[VINRetrieverLIB] Failed to process or validate VIN from the final response.',
          );
        }
      } else {
        log.error(
          '[VINRetrieverLIB] Failed to get any valid response after all attempts (including flow control).',
        );
      }

      return null;
    } catch (error) {
      log.error(
        '[VINRetrieverLIB] VIN retrieval process failed with exception:',
        error,
      );
      return null;
    } finally {
      // Optionally reset AT mode after attempt? Or leave it for next command?
      // this.currentATMode = 0;
    }
  }

  /**
   * Processes the raw byte arrays from the adapter to extract the VIN string.
   * Handles multi-frame ISO-TP responses.
   */
  private processVINResponse(rawResponseBytes: number[][]): string | null {
    // Match updated type
    log.debug('[VINRetrieverLIB] Starting processVINResponse...');
    try {
      let combinedString = '';
      let combinedBytes: number[] = [];
      for (const byteArray of rawResponseBytes) {
        // No need to convert Uint8Array if type is number[][]
        if (Array.isArray(byteArray)) {
          combinedBytes = combinedBytes.concat(byteArray);
        }
      }
      combinedString = String.fromCharCode(...combinedBytes);

      log.debug(
        '[VINRetrieverLIB] Combined Raw String:',
        combinedString.replace(/[^\x20-\x7E]/g, '.'),
      );

      const lines = combinedString.split(/[\r\n]+/);
      log.debug('[VINRetrieverLIB] Split Lines:', lines);

      let assembledVINData = '';
      let isMultiFrameSequence = false;
      let expectedFrameIndex = 1;
      let totalVINLength = 0;
      let foundPositiveResponse = false; // Track if we found 4902

      // Noise patterns (keep existing comprehensive list)
      const noisePatterns = [
        /^AT/i,
        /^OK$/i,
        /^\?$/,
        /^>$/,
        /^SEARCHING/i,
        /^BUS INIT/i,
        /^STOPPED$/i,
        /^NO DATA$/i,
        /^ERROR$/i,
        /^CAN ERROR$/i,
        /^BUFFER FULL$/i,
        /^UNABLE TO CONNECT$/i,
        /^FB ERROR$/i,
        /^DATA ERROR$/i,
        /^ELM327/i,
        /^[0-9.]+V$/i,
        /^7F09/i /* Negative response for 09 */,
      ];

      for (const line of lines) {
        let processedLine = line.trim();
        if (!processedLine) continue;

        // Check for noise first
        const cleanedForNoiseCheck = processedLine
          .replace(/\s/g, '')
          .toUpperCase();
        if (noisePatterns.some(pattern => pattern.test(cleanedForNoiseCheck))) {
          log.debug(
            '[VINRetrieverLIB] Discarding noise/status/error line:',
            processedLine,
          );
          continue;
        }

        // Strip ELM frame numbering (e.g., "0:", "1:") - CRUCIAL
        processedLine = processedLine.replace(/^\s*[0-9A-F]{1,2}:\s*/, '');
        const hexLine = processedLine.replace(/[^0-9A-F]/gi, '').toUpperCase();
        if (!hexLine) continue;

        log.debug(`[VINRetrieverLIB] Processing Hex Line: ${hexLine}`);

        // --- ISO-TP Frame processing ---
        const vinResponseStartIndex = hexLine.indexOf('4902');

        let dataPart = hexLine; // Start by assuming the whole line might be data

        if (!isMultiFrameSequence) {
          // Look for the start of the VIN data (4902)
          if (vinResponseStartIndex !== -1) {
            foundPositiveResponse = true;
            dataPart = hexLine.substring(vinResponseStartIndex + 4); // Data after 4902
            log.debug(
              `[VINRetrieverLIB] Found 4902 marker. Data part: ${dataPart}`,
            );

            const frameTypeNibble = dataPart.substring(0, 1);
            const pciSecondNibble = dataPart.substring(1, 2);

            if (frameTypeNibble === '0') {
              // Single Frame (SF)
              const length = parseInt(pciSecondNibble, 16);
              if (
                !isNaN(length) &&
                length > 0 &&
                dataPart.length >= 2 + length * 2
              ) {
                assembledVINData = dataPart.substring(2, 2 + length * 2);
                log.debug(
                  `[VINRetrieverLIB] Found Single Frame (SF). Length: ${length}, Data: ${assembledVINData}`,
                );
                break; // SF is complete
              } else {
                log.warn('[VINRetrieverLIB] Invalid Single Frame format:', {
                  dataPart,
                  length,
                });
                // Don't immediately fail, maybe next line has it? Reset state.
                foundPositiveResponse = false;
                continue;
              }
            } else if (frameTypeNibble === '1') {
              // First Frame (FF)
              const lengthHex = dataPart.substring(1, 4); // 12 bits length (0xFFF max)
              totalVINLength = parseInt(lengthHex, 16);
              // Basic validation for FF length (must be > 7 for MF, usually 17 for VIN -> 0x11)
              if (
                !isNaN(totalVINLength) &&
                totalVINLength > 0 &&
                dataPart.length >= 4
              ) {
                // VIN is typically 17 bytes (0x11) + 1 byte count = 18 bytes total (0x12)
                if (totalVINLength < 8 || totalVINLength > 40) {
                  // Allow some flexibility around 18
                  log.warn('[VINRetrieverLIB] Unusual First Frame length:', {
                    totalVINLength,
                    dataPart,
                  });
                }
                isMultiFrameSequence = true;
                expectedFrameIndex = 1;
                assembledVINData = dataPart.substring(4); // Initial data
                log.debug(
                  `[VINRetrieverLIB] Found First Frame (FF). Expected Length: ${totalVINLength}, Initial Data: ${assembledVINData}`,
                );
              } else {
                log.warn(
                  '[VINRetrieverLIB] Invalid First Frame format or length:',
                  { dataPart, totalVINLength },
                );
                foundPositiveResponse = false;
                continue;
              }
            } else {
              // Found 4902 but not SF or FF. Could be non-ISO-TP response.
              log.debug(
                '[VINRetrieverLIB] Found 4902 but not ISO-TP SF/FF. Treating as single data chunk:',
                { dataPart },
              );
              assembledVINData = dataPart;
              break; // Assume complete
            }
          } else {
            // Line doesn't contain 4902 and not in sequence, discard.
            log.debug(
              '[VINRetrieverLIB] Discarding line without 4902 (not in sequence):',
              hexLine,
            );
            continue;
          }
        } else {
          // --- In a multi-frame sequence ---
          const frameTypeNibble = dataPart.substring(0, 1);
          const pciSecondNibble = dataPart.substring(1, 2);

          if (frameTypeNibble === '2') {
            // Consecutive Frame (CF)
            const sequenceNumber = parseInt(pciSecondNibble, 16);
            if (
              !isNaN(sequenceNumber) &&
              sequenceNumber === expectedFrameIndex % 16
            ) {
              assembledVINData += dataPart.substring(2);
              expectedFrameIndex++;
              log.debug(
                `[VINRetrieverLIB] Found Consecutive Frame (CF). Seq: ${sequenceNumber}, Data: ${dataPart.substring(2)}`,
              );
            } else {
              log.warn(
                `[VINRetrieverLIB] Invalid or out-of-sequence CF. Expected ${expectedFrameIndex % 16}, got ${sequenceNumber}. Resetting sequence.`,
                { dataPart },
              );
              isMultiFrameSequence = false;
              assembledVINData = '';
              foundPositiveResponse = false;
              continue;
            }
          } else if (frameTypeNibble === '3') {
            // Flow Control (FC)
            log.debug('[VINRetrieverLIB] Ignoring Flow Control Frame (FC):', {
              dataPart,
            });
            // Potentially parse FC frame here if needed for advanced logic
          } else {
            log.warn(
              '[VINRetrieverLIB] Unexpected frame type during multi-frame sequence:',
              { dataPart },
            );
            // Reset sequence on unexpected frame
            isMultiFrameSequence = false;
            assembledVINData = '';
            foundPositiveResponse = false;
            continue;
          }
        }

        // Check completion for multi-frame
        if (
          isMultiFrameSequence &&
          totalVINLength > 0 &&
          assembledVINData.length >= totalVINLength * 2
        ) {
          log.debug(
            `[VINRetrieverLIB] Multi-frame complete. Expected ${totalVINLength} bytes, got ${assembledVINData.length / 2}.`,
          );
          assembledVINData = assembledVINData.substring(0, totalVINLength * 2); // Trim excess
          break; // Message complete
        }
      } // End line processing loop

      if (!assembledVINData && foundPositiveResponse) {
        log.warn(
          '[VINRetrieverLIB] Found 4902 but failed to assemble VIN data (likely incomplete/invalid frames).',
        );
        return null;
      }
      if (!assembledVINData) {
        log.warn(
          '[VINRetrieverLIB] No valid VIN data could be assembled from the response.',
        );
        return null;
      }

      log.debug('[VINRetrieverLIB] Assembled VIN Hex:', assembledVINData);

      // --- Post-Assembly Processing ---
      let vinHex = assembledVINData;

      // Handle potential data count prefix (e.g., 01 for VIN)
      // Check if length suggests a prefix (e.g., 18 bytes total = 36 hex chars)
      if (vinHex.length === 36 && vinHex.startsWith('01')) {
        log.debug(
          '[VINRetrieverLIB] Detected potential VIN count prefix (01), removing.',
        );
        vinHex = vinHex.substring(2); // Skip the '01'
      } else if (vinHex.length === 34) {
        // Exactly 17 bytes, likely no prefix
        log.debug(
          '[VINRetrieverLIB] Assembled data is exactly 17 bytes, assuming no prefix.',
        );
      } else {
        log.warn(
          `[VINRetrieverLIB] Assembled VIN hex has unexpected length (${vinHex.length} chars). Attempting to parse anyway.`,
        );
        // Try to extract the last 34 chars if too long? Or first 34? Let's try first.
        if (vinHex.length > 34) {
          vinHex = vinHex.substring(0, 34);
          log.debug(
            `[VINRetrieverLIB] Truncated VIN hex to first 34 chars: ${vinHex}`,
          );
        }
      }

      // Handle potential null padding (00) at the end
      vinHex = vinHex.replace(/00+$/, '');
      log.debug(`[VINRetrieverLIB] VIN Hex after padding removal: ${vinHex}`);

      // Final length check before conversion
      if (vinHex.length < 34) {
        log.warn(
          `[VINRetrieverLIB] Final VIN hex data too short (${vinHex.length} chars). Expected 34.`,
        );
        return null;
      }
      // Ensure we only take 34 chars max if padding removal was insufficient
      if (vinHex.length > 34) {
        vinHex = vinHex.substring(0, 34);
      }

      const vin = this.hexToAscii(vinHex);
      log.debug('[VINRetrieverLIB] Parsed VIN String:', vin);

      if (this.isValidVIN(vin)) {
        log.info('[VINRetrieverLIB] Valid VIN found:', vin);
        return vin;
      } else {
        log.warn('[VINRetrieverLIB] Parsed string is not valid VIN format.', {
          vin,
        });
        return null;
      }
    } catch (error: unknown) {
      log.error('[VINRetrieverLIB] Error processing VIN response:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

  /**
   * Attempts VIN retrieval using different CAN flow control configurations.
   * @param activeProtocol - The currently active protocol number.
   * @param selectedEcuAddress - The currently selected ECU address (if any).
   */
  private async tryFlowControl(
    activeProtocol: PROTOCOL | null,
    selectedEcuAddress: string | null,
  ): Promise<ChunkedResponse | null> {
    // Use passed-in parameters instead of ecuStore.getState() here
    if (activeProtocol === null) {
      log.error(
        '[VINRetrieverLIB] Cannot attempt flow control: Active protocol is null (passed from caller).',
      );
      return null;
    }
    // Determine CAN type based on passed-in protocol and address
    const is29Bit =
      selectedEcuAddress?.startsWith('18DA') || // Check passed address first
      activeProtocol === PROTOCOL.ISO_15765_4_CAN_29BIT_500K || // 7
      activeProtocol === PROTOCOL.ISO_15765_4_CAN_29BIT_250K || // 9
      activeProtocol === PROTOCOL.SAE_J1939_CAN_29BIT_250K || // 10 (A)
      activeProtocol === PROTOCOL.ISO_15765_4_CAN_29BIT_500K_4 || // 14 (E)
      activeProtocol === PROTOCOL.ISO_15765_4_CAN_29BIT_250K_4 || // 16 (10)
      activeProtocol === PROTOCOL.ISO_15765_4_CAN_29BIT_500K_8 || // 18 (12)
      activeProtocol === PROTOCOL.ISO_15765_4_CAN_29BIT_250K_8; // 20 (14)

    const baseConfig = is29Bit
      ? VIN_CONSTANTS.CAN_CONFIGS.find(c => c.canType === '29bit')
      : VIN_CONSTANTS.CAN_CONFIGS.find(c => c.canType === '11bit');

    if (!baseConfig) {
      log.error(
        '[VINRetrieverLIB] Cannot determine base CAN config for flow control attempts.',
      );
      return null;
    }

    const flowAddr = baseConfig.flowAddr; // Use the determined flow address

    for (const fcConfig of VIN_CONSTANTS.FLOW_CONTROL_CONFIGS) {
      try {
        log.debug(
          `[VINRetrieverLIB] Trying flow control config: ${fcConfig.desc}`,
        );

        // Set flow control parameters for this attempt
        const fcshCmd = `ATFCSH${flowAddr}`; // Use determined flow address
        const fcsdCmd = `ATFCSD${fcConfig.fcsd}`;
        const fcsmCmd = `ATFCSM${fcConfig.fcsm}`;

        log.debug(
          `[VINRetrieverLIB] Applying FC commands: ${fcshCmd}, ${fcsdCmd}, ${fcsmCmd}`,
        );

        let res = await this.sendCommand(fcshCmd);
        this.adjustAdaptiveTiming(this.isValidCommandResponse(res));
        await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);

        res = await this.sendCommand(fcsdCmd);
        this.adjustAdaptiveTiming(this.isValidCommandResponse(res));
        await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);

        res = await this.sendCommand(fcsmCmd);
        this.adjustAdaptiveTiming(this.isValidCommandResponse(res));
        await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);

        // Re-send VIN request with this flow control config
        log.debug(
          '[VINRetrieverLIB] Sending VIN request with current flow control config...',
        );
        const response = await this.sendCommandRaw(VIN_CONSTANTS.COMMAND, {
          timeout: VIN_CONSTANTS.TIMEOUT,
        });

        const isValid =
          response?.rawResponse && response.rawResponse.length > 0;
        this.adjustAdaptiveTiming(isValid ?? false); // Ensure boolean

        if (isValid && response.rawResponse) {
          // Add check for rawResponse existence
          const validation = this.checkResponseForErrors(response.rawResponse);
          // Check if we got a non-error response OR a potentially recoverable error
          if (
            !validation.error ||
            validation.error.includes('Negative Response') ||
            validation.error.includes('Potential Negative Response')
          ) {
            log.info(
              `[VINRetrieverLIB] Flow control config "${fcConfig.desc}" yielded a potentially valid response.`,
            );
            // Attempt to process it immediately to see if it's the VIN
            const potentialVin = this.processVINResponse(response.rawResponse);
            if (potentialVin && this.isValidVIN(potentialVin)) {
              log.info(
                `[VINRetrieverLIB] Successfully retrieved VIN using flow control: ${fcConfig.desc}`,
              ); // Use log.info
              return response; // Return the successful response object
            } else {
              log.debug(
                `[VINRetrieverLIB] Flow control config "${fcConfig.desc}" response did not yield a valid VIN, continuing...`,
              );
            }
          } else {
            log.debug(
              `[VINRetrieverLIB] Flow control config "${fcConfig.desc}" failed with error: ${validation.error}`,
            );
          }
        } else {
          log.debug(
            `[VINRetrieverLIB] Flow control config "${fcConfig.desc}" yielded invalid/empty response.`,
          );
        }

        // Add delay between trying different flow control configs
        await this.delay(VIN_CONSTANTS.DELAYS.PROTOCOL);
      } catch (error) {
        this.adjustAdaptiveTiming(false); // Adjust timing on error
        log.warn(
          `[VINRetrieverLIB] Flow control config ${fcConfig.desc} failed with exception:`,
          error,
        );
        // Ensure delay before next attempt even if one config throws error
        await this.delay(VIN_CONSTANTS.DELAYS.PROTOCOL);
      }
    }

    log.warn(
      '[VINRetrieverLIB] All flow control configurations attempted without retrieving a valid VIN.',
    );
    return null;
  }
}
