import { log } from '../../utils/logger';
import { RESPONSE_KEYWORDS, PROTOCOL } from '../utils/constants';
import { isResponseError } from '../utils/helpers';
import { hexToBytes, bytesToHex, bytesToString } from '../utils/ecuUtils';
import { ecuStore, getStore } from '../context/ECUStore';
import type {
  SendCommandFunction,
  SendCommandRawFunction,
  ChunkedResponse,
  VINConstants,
  ResponseValidation,
  CANConfig,
  CommandConfig,
} from './types';

// Modify VIN_CONSTANTS definition to include functionalHeader in CAN_CONFIGS
const VIN_CONSTANTS: VINConstants = {
  COMMAND: '0902',
  TIMEOUT: 5000, // Reduced from 10000 to be more responsive
  RETRIES: 2,
  DELAYS: {
    INIT: 250,
    COMMAND: 150,
    PROTOCOL: 200,
    ADAPTIVE_BASE: 80,
    ST_TIMEOUT: 100, // Add timeout adjustment delay
    FC_SETUP: 75, // Added delay for flow control setup steps
  },
  INIT_SEQUENCE_PRE_PROTOCOL: [
    { cmd: 'ATE0', delay: 100 },
    { cmd: 'ATL0', delay: 100 },
    { cmd: 'ATS0', delay: 100 },
    { cmd: 'ATH1', delay: 100 },
    { cmd: 'ATCAF0', delay: 100 }, // Changed ATCAF1 to ATCAF0
    { cmd: 'ATST64', delay: 100 },
  ],
  INIT_SEQUENCE_POST_PROTOCOL: [],
  CAN_CONFIGS: [
    {
      desc: '11-bit Standard',
      functionalHeader: '7DF', // Added functionalHeader
      receiveAddr: '7E8',
      flowAddr: '7E0',
      canType: '11bit',
      adaptiveTimingMode: 2,
      commands: [
        // REMOVED: { cmd: 'ATCRA7E8', delay: 100 },
        // REMOVED: { cmd: 'ATCF7E8', delay: 100 },
      ],
    },
    {
      desc: '29-bit Standard',
      functionalHeader: '18DB33F1', // Added functionalHeader
      receiveAddr: '18DAF110',
      flowAddr: '18DA10F1',
      canType: '29bit',
      adaptiveTimingMode: 2,
      commands: [
        // REMOVED: { cmd: 'ATCRA18DAF110', delay: 100 },
        // REMOVED: { cmd: 'ATCF18DAF110', delay: 100 },
      ],
    },
  ],
  FLOW_CONTROL_CONFIGS: [
    { fcsh: '', fcsd: '300000', fcsm: '1', desc: 'Standard Mode 1' },
    { fcsh: '', fcsd: '300000', fcsm: '0', desc: 'Standard Mode 0' },
    { fcsh: '', fcsd: '300008', fcsm: '1', desc: 'Extended Wait Mode 1' },
    { fcsh: '', fcsd: '300100', fcsm: '1', desc: 'Block Size 1 Mode 1' },
    // Add these new configurations
    { fcsh: '', fcsd: '300400', fcsm: '1', desc: 'Block Size 4 Mode 1' }, // Different block size
    { fcsh: '', fcsd: '300004', fcsm: '1', desc: 'Separation Time 4ms' }, // Shorter separation time
  ],
  ALTERNATE_HEADERS: [
    '7DF',    // Standard 11-bit broadcast
    '7E0',    // Standard ECU address
    '18DB33F1', // Standard 29-bit broadcast
    'DB33F1',   // Alternate 29-bit format
    '18DA10F1', // Common ECU address
  ],
} as const;

export class VINRetriever {
  private sendCommand: SendCommandFunction;
  private sendCommandRaw: SendCommandRawFunction;
  private currentAdaptiveDelay: number;
  private currentATMode: 0 | 1 | 2;
  private currentFunctionalHeader: string | null = null; // Ensure this is initialized
  // Update type definitions to be explicit about null
  private currentProtocol: PROTOCOL | null = null;
  private selectedEcuAddress: string | null = null;

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
    this.currentAdaptiveDelay = VIN_CONSTANTS.DELAYS.ADAPTIVE_BASE;
    this.currentATMode = 0;
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
    // Use ecuUtils functions instead of manual conversion
    const bytes = hexToBytes(hex);
    const str = bytesToString(bytes);

    // Filter for VIN-valid characters only (0-9, A-Z except IOQ)
    return str.replace(/[^A-HJ-NPR-Z0-9]/gi, '').toUpperCase();
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
    rawResponseBytes: number[][] | null | undefined,
  ): ResponseValidation {
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
      // Convert all chunks to a single string using ecuUtils
      result.rawString = rawResponseBytes
        .map(chunk => bytesToString(chunk))
        .join('');

      // Clean hex using ecuUtils functions
      const combinedBytes = rawResponseBytes.flat();
      result.cleanHex = bytesToHex(combinedBytes);
    } catch (e) {
      log.error('[VINRetrieverLIB] Error processing response bytes:', e);
      result.error = 'Byte processing error';
      return result;
    }

    // Basic cleaning for error keyword checking
    const basicCleaned = result.rawString
      .replace(/[>\r\n]/g, ' ') // Replace prompt/newlines with space
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

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

  private isValidCommandResponse(
    command: string,
    response: string | null,
  ): boolean {
    if (!response) {
      log.debug('[VINRetrieverLIB] isValidCommandResponse: Received null response.');
      return false;
    }

    // Basic cleaning: remove prompt, trim whitespace
    const trimmedResponse = response.replace(/>/g, '').trim();
    // Uppercase for keyword checks
    const upperResponse = trimmedResponse.toUpperCase();
    // Clean response without spaces for specific checks
    const cleanNoSpace = upperResponse.replace(/\s/g, '');
    // Uppercase command for checks
    const upperCommand = command.toUpperCase();

    log.debug(
      `[VINRetrieverLIB] isValidCommandResponse: Evaluating trimmed response: "${trimmedResponse}" (Original: "${response}") for command "${command}"`,
    );

    // Special case for protocol setting commands (ATSPX)
    if (upperCommand.startsWith('ATSP')) {
      // Accept OK or the echo ATSPx62 (or similar)
      const isSpOk = upperResponse.includes(RESPONSE_KEYWORDS.OK) ||
                     cleanNoSpace.includes(upperCommand); // Check if echo is present
      if (isSpOk) {
        log.debug(`[VINRetrieverLIB] Valid ATSP response: ${trimmedResponse}`);
        return true;
      }
    }

    // Special case for ATCAF0
    if (upperCommand === 'ATCAF0') {
      // Accept OK or the echo ATCAF062 (or similar)
      const isCafOk = upperResponse.includes(RESPONSE_KEYWORDS.OK) ||
                      cleanNoSpace.includes(upperCommand); // Check if echo is present
      if (isCafOk) {
        log.debug(`[VINRetrieverLIB] Valid ATCAF0 response: ${trimmedResponse}`);
        return true;
      }
    }

    // Special case for ATSTxx commands
    if (upperCommand.startsWith('ATST')) {
      // Accept OK or the echo ATSTxx62 (or similar)
      const isStOk = upperResponse.includes(RESPONSE_KEYWORDS.OK) ||
                     cleanNoSpace.includes(upperCommand); // Check if echo is present
      if (isStOk) {
        log.debug(`[VINRetrieverLIB] Valid ATST response: ${trimmedResponse}`);
        return true;
      }
    }

    // 1. Check for definite error keywords or 7F prefix
    if (
      upperResponse.includes(RESPONSE_KEYWORDS.ERROR) ||
      upperResponse.includes(RESPONSE_KEYWORDS.CAN_ERROR) ||
      upperResponse.includes(RESPONSE_KEYWORDS.BUS_ERROR) ||
      upperResponse.includes(RESPONSE_KEYWORDS.NO_DATA) ||
      upperResponse.includes(RESPONSE_KEYWORDS.UNABLE_TO_CONNECT) ||
      upperResponse.startsWith('7F')
    ) {
      log.debug(
        `[VINRetrieverLIB] isValidCommandResponse: Detected error keyword/prefix in "${upperResponse}". Result: false`,
      );
      return false;
    }

    // 2. Check if the response is *only* a question mark
    if (trimmedResponse === RESPONSE_KEYWORDS.QUESTION_MARK) {
      log.debug(`[VINRetrieverLIB] isValidCommandResponse: Detected lone '?' error. Result: false`);
      return false;
    }

    // 3. Check for common success patterns
    const isOk = upperResponse.includes(RESPONSE_KEYWORDS.OK);
    // Use cleanNoSpace for endsWith check to handle potential spaces before 62
    const endsWith62 = cleanNoSpace.endsWith('62');
    const isElm = upperResponse.includes(RESPONSE_KEYWORDS.ELM_MODEL);
    const isEmptyAfterTrim = trimmedResponse === '';
    const startsWithValidEcu = upperResponse.startsWith('41'); // Valid ECU response

    // Check if the response is simply the command echoed back (common for some commands)
    const isEcho = cleanNoSpace === upperCommand;

    const isValid = isOk || endsWith62 || isElm || isEmptyAfterTrim || startsWithValidEcu || isEcho;

    log.debug(
      `[VINRetrieverLIB] isValidCommandResponse: Checks for "${trimmedResponse}": isOk=${isOk}, endsWith62=${endsWith62}, isElm=${isElm}, isEmpty=${isEmptyAfterTrim}, validEcu=${startsWithValidEcu}, isEcho=${isEcho}. Result: ${isValid}`,
    );

    return isValid;
  }

  private async executeCommandSequence(
    commands: ReadonlyArray<CommandConfig>,
    failFast: boolean = true, // Add option to fail immediately on invalid response
  ): Promise<boolean> {
    for (const { cmd, delay: baseDelay } of commands) {
      const response = await this.sendCommand(cmd);
      const isValid = this.isValidCommandResponse(cmd, response);
      this.adjustAdaptiveTiming(isValid); // Adjust timing based on response validity
      if (!isValid) {
        log.warn(
          // Changed to warn, but check failFast
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
      if (this.isValidCommandResponse(cmd, response)) {
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
      if (this.isValidCommandResponse(cmd, response)) {
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
      if (this.isValidCommandResponse(cmd, response)) {
        this.currentATMode = 0;
        log.info(`[VINRetrieverLIB] Adaptive timing disabled (fixed timing).`);
      } else {
        log.error(`[VINRetrieverLIB] Failed to disable adaptive timing!`);
      }
    }
    await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);
  }

  private async initializeDevice(): Promise<boolean> {
    try {
      const state = ecuStore.getState();
      // Add null check and type safety for address
      this.selectedEcuAddress = state.selectedEcuAddress || null;
      this.currentFunctionalHeader = null; // Reset before initialization

      const currentProtocol = state.activeProtocol;
      if (currentProtocol === null) {
        log.error(
          '[VINRetrieverLIB] Prerequisite failed: Active protocol is null.',
        );
        return false;
      }

      // Store protocol only after validation
      this.currentProtocol = currentProtocol;
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

      // 3. Basic ELM Setup (Pre-Protocol) - Allow continuation even if some fail
      log.debug('[VINRetrieverLIB] Sending pre-protocol init sequence...');
      if (
        !(await this.executeCommandSequence(
          VIN_CONSTANTS.INIT_SEQUENCE_PRE_PROTOCOL,
          false, // Set failFast to false for pre-protocol commands
        ))
      ) {
        // Log if the sequence didn't complete fully, but don't necessarily fail yet.
        log.warn(
          '[VINRetrieverLIB] Pre-protocol initialization sequence encountered errors (failFast=false).',
        );
        // Continue to the next steps, relying on them to fail if critical setup failed.
      }

      // 4. Set Protocol Explicitly - Fail fast (This IS critical)
      const protocolCmd = `ATSP${currentProtocol}`; // Use validated currentProtocol
      log.debug(
        `[VINRetrieverLIB] Setting protocol explicitly: ${protocolCmd}`,
      );
      const spResponse = await this.sendCommand(protocolCmd);
      const isSpValid = this.isValidCommandResponse(protocolCmd, spResponse);
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
      if (!(await this.executeCommandSequence(config.commands, true))) {
        // Fail fast
        log.error('[VINRetrieverLIB] CAN specific initialization failed.');
        return false;
      }

      // 8. Set Header (using selected address or default from config) - Fail fast
      const headerToSet = state.selectedEcuAddress || config.functionalHeader;
      const headerCmd = `ATSH${headerToSet}`;
      log.debug(`[VINRetrieverLIB] Setting header: ${headerCmd}`);
      const shResponse = await this.sendCommand(headerCmd);
      const isShValid = this.isValidCommandResponse(headerCmd, shResponse);
      this.adjustAdaptiveTiming(isShValid);
      if (!isShValid) {
        log.error(
          `[VINRetrieverLIB] Failed to set header ${headerToSet}. Response: ${shResponse}. Aborting.`,
        );
        return false; // Fail fast
      }
      // Store the successfully set header
      this.currentFunctionalHeader = headerToSet;
      log.info(`[VINRetrieverLIB] Header successfully set to: ${this.currentFunctionalHeader}`);
      await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);

      // Add ST timeout adjustment before VIN request
      log.debug('[VINRetrieverLIB] Setting ST timeout for VIN request...');
      const stCmd = 'ATST64'; // ~100ms * 4 = 400ms internal timeout
      const stResponse = await this.sendCommand(stCmd);
      if (!this.isValidCommandResponse(stCmd, stResponse)) {
        log.warn('[VINRetrieverLIB] Failed to set ST timeout, continuing...');
      }
      await this.delay(VIN_CONSTANTS.DELAYS.ST_TIMEOUT);

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
      this.currentFunctionalHeader = null; // Reset header on error
      return false;
    }
  }

  private async sendVINRequest(attempt = 1): Promise<ChunkedResponse | null> {
    try {
      // Use the header already set during initializeDevice
      const headerToUse = this.currentFunctionalHeader || 'Unknown'; // Get header set in init
      log.debug(
        `[VINRetrieverLIB] Sending initial VIN request with header: ${headerToUse}`,
      );

      // Send VIN request - fix options format
      let response = await this.sendCommandRaw(VIN_CONSTANTS.COMMAND, {
        raw: true,
        // Remove timeout completely for VIN request
      });

      if (response?.rawResponse && response.rawResponse.length > 0) {
        const validation = this.checkResponseForErrors(response.rawResponse);
        // Check for specific errors that mean we should stop, otherwise return the response
        if (
          !validation.error ||
          !(
            validation.error.includes('No Data') ||
            validation.error.includes('Timeout') ||
            validation.error.includes('Unable to Connect') ||
            validation.error.includes('Negative Response')
          )
        ) {
          log.debug(
            `[VINRetrieverLIB] Got response with header ${headerToUse}`,
          );
          return response;
        } else {
          log.warn(
            `[VINRetrieverLIB] Initial VIN request with header ${headerToUse} resulted in error: ${validation.error}`,
          );
        }
      } else {
        log.warn(
          `[VINRetrieverLIB] Initial VIN request with header ${headerToUse} yielded no response.`,
        );
      }

      // If the initial attempt failed significantly, return null to trigger flow control logic
      return null;
    } catch (error) {
      this.adjustAdaptiveTiming(false); // Adjust timing on error
      log.error(
        '[VINRetrieverLIB] Initial VIN request failed with exception:',
        error,
      );
      // Retry logic for exceptions on the initial request
      if (attempt < VIN_CONSTANTS.RETRIES) {
        await this.delay(VIN_CONSTANTS.DELAYS.INIT);
        return this.sendVINRequest(attempt + 1);
      }
      return null;
    }
  }

  public async retrieveVIN(): Promise<string | null> {
    try {
      const currentState = getStore();
      const currentProtocol = currentState.activeProtocol;

      if (!currentProtocol) {
        log.error('[VINRetrieverLIB] Cannot retrieve VIN: No protocol set');
        return null;
      }

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
          log.info(
            '[VINRetrieverLIB] Standard VIN request successful (found 4902).',
          );
          needsFlowControl = false;
        } else {
          log.info(
            '[VINRetrieverLIB] Standard VIN request did not contain 4902, proceeding to flow control.',
          );
        }
      } else {
        log.info(
          '[VINRetrieverLIB] Standard VIN request failed or yielded empty response, proceeding to flow control.',
        );
      }

      // If standard request failed OR didn't contain 4902, try variations with flow control
      if (needsFlowControl) {
        log.info('[VINRetrieverLIB] Trying flow control configurations...');
        response = await this.tryFlowControl(
          currentProtocol, // Now guaranteed to be non-null
          currentState.selectedEcuAddress || null,
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
   * Process VIN response using improved byte handling
   */
  private processVINResponse(rawResponseBytes: number[][]): string | null {
    try {
      // Combine all bytes and convert to a single hex string
      const combinedBytes = rawResponseBytes.flat();
      const fullHexString = bytesToHex(combinedBytes);

      log.debug(`[VINRetrieverLIB] Processing Hex: ${fullHexString}`);

      // Search for the positive response code '4902'
      const vinResponseMarker = '4902';
      const markerIndex = fullHexString.indexOf(vinResponseMarker);

      if (markerIndex === -1) {
        log.warn(
          `[VINRetrieverLIB] Positive response marker '${vinResponseMarker}' not found in hex: ${fullHexString}`,
        );
        // Check for the echo '0902' which might indicate command echo instead of response
        if (fullHexString.includes('0902')) {
            log.warn(`[VINRetrieverLIB] Found command echo '0902' instead of VIN data.`);
        }
        return null;
      }

      // Extract the hex data following the marker
      // The marker itself is 4 chars long. The next 2 chars (e.g., '01') are part of the ISO-TP header/metadata.
      // VIN data starts after these next 2 chars.
      const vinHexDataStartIndex = markerIndex + vinResponseMarker.length + 2;
      const vinHexData = fullHexString.substring(vinHexDataStartIndex);

      if (!vinHexData) {
        log.warn('[VINRetrieverLIB] No VIN hex data found after marker.');
        return null;
      }

      log.debug(`[VINRetrieverLIB] Extracted VIN Hex: ${vinHexData}`);

      // Convert extracted hex to ASCII using ecuUtils functions
      const vin = this.hexToAscii(vinHexData);
      log.debug(`[VINRetrieverLIB] Converted to ASCII: ${vin}`);

      return this.isValidVIN(vin) ? vin : null;
    } catch (error) {
      log.error('[VINRetrieverLIB] Error processing VIN response:', error);
      return null;
    }
  }

  /**
   * Attempts VIN retrieval using different CAN flow control configurations.
   * @param activeProtocol - The currently active protocol number.
   * @param selectedEcuAddress - The currently selected ECU address (if any).
   */
  private async tryFlowControl(
    activeProtocol: PROTOCOL,
    selectedEcuAddress: string | null,
  ): Promise<ChunkedResponse | null> {
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
      log.debug(
        `[VINRetrieverLIB] Trying Flow Control Config: ${fcConfig.desc}`,
      );
      try {
        // For each flow control config, try each header
        for (const header of VIN_CONSTANTS.ALTERNATE_HEADERS) {
          log.debug(`[VINRetrieverLIB] Setting Header: ATSH${header}`);
          await this.sendCommand(`ATSH${header}`);
          await this.delay(VIN_CONSTANTS.DELAYS.FC_SETUP); // Increased delay

          // Apply flow control settings
          log.debug(
            `[VINRetrieverLIB] Applying FC Settings: FCSH=${flowAddr}, FCSD=${fcConfig.fcsd}, FCSM=${fcConfig.fcsm}`,
          );
          await this.sendCommand(`ATFCSH${flowAddr}`);
          await this.delay(VIN_CONSTANTS.DELAYS.FC_SETUP); // Increased delay
          await this.sendCommand(`ATFCSD${fcConfig.fcsd}`);
          await this.delay(VIN_CONSTANTS.DELAYS.FC_SETUP); // Increased delay
          await this.sendCommand(`ATFCSM${fcConfig.fcsm}`);
          await this.delay(VIN_CONSTANTS.DELAYS.FC_SETUP); // Increased delay

          // Send VIN request without timeout
          log.debug(
            `[VINRetrieverLIB] Sending VIN request (FC: ${fcConfig.desc}, Header: ${header})`,
          );
          const response = await this.sendCommandRaw(VIN_CONSTANTS.COMMAND, {
            raw: true,
          });

          if (response?.rawResponse && response.rawResponse.length > 0) {
            // Check if this response contains the VIN marker '4902'
            const combinedBytes = response.rawResponse.flat();
            const hexString = bytesToHex(combinedBytes);
            if (hexString.includes('4902')) {
              log.info(
                `[VINRetrieverLIB] Found potential VIN response with FC: ${fcConfig.desc}, Header: ${header}`,
              );
              // Return the successful response immediately
              return response;
            } else {
              log.debug(
                `[VINRetrieverLIB] Response received but no '4902' marker found (FC: ${fcConfig.desc}, Header: ${header}). Hex: ${hexString}`,
              );
            }
          } else {
            log.debug(
              `[VINRetrieverLIB] No response for FC: ${fcConfig.desc}, Header: ${header}`,
            );
          }

          // Delay before trying the next header within the same FC config
          await this.delay(VIN_CONSTANTS.DELAYS.COMMAND); // Use standard command delay
        } // End header loop
      } catch (error) {
        this.adjustAdaptiveTiming(false); // Adjust timing on error
        log.warn(
          `[VINRetrieverLIB] Flow control config ${fcConfig.desc} failed with exception:`,
          error,
        );
        // Ensure delay before next attempt even if one config throws error
        await this.delay(VIN_CONSTANTS.DELAYS.PROTOCOL);
      }
      // Delay before trying the next flow control configuration
      await this.delay(VIN_CONSTANTS.DELAYS.PROTOCOL);
    } // End flow control config loop

    log.warn(
      '[VINRetrieverLIB] All flow control configurations attempted without retrieving a valid VIN response containing "4902".',
    );
    return null;
  }
}
