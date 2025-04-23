import { log } from '../../utils/logger';
import { DELAYS_MS, RESPONSE_KEYWORDS, ELM_COMMANDS } from '../utils/constants';
import { isResponseError } from '../utils/helpers';
import { bytesToHex, bytesToString } from '../utils/ecuUtils';
import { ecuStore } from '../context/ECUStore';

import type {
  SendCommandFunction,
  SendCommandRawFunction,
  ChunkedResponse,
} from '../utils/types';

// Constants for VIN retrieval
const VIN_CONSTANTS = {
  COMMAND: '0902',
  TIMEOUT: 8000,    // Reduced from 15000
  DELAYS: {
    INIT: 500,      // Reduced from 1000
    COMMAND: 200,   // Reduced from 300
    RESPONSE: 300   // Reduced from 500
  },
  CAN_INIT_SEQUENCE: [
    { cmd: 'ATE0', desc: 'Echo off' },
    { cmd: 'ATL0', desc: 'Linefeeds off' },
    { cmd: 'ATH1', desc: 'Headers on' },
    { cmd: 'ATCAF1', desc: 'Formatting on' },
    { cmd: 'ATST64', desc: 'Set timeout' },
    { cmd: 'ATFCSM1', desc: 'Flow control mode' },
    { cmd: 'ATFCSH7E8', desc: 'Flow control header' },
    { cmd: 'ATCRA7E8', desc: 'Set receive address' }
  ],
  VALID_RESPONSES: [
    'OK',
    '>', 
    'ELM327',
    '62'  // Common success suffix
  ]
} as const;

export class VINRetriever {
  private sendCommand: SendCommandFunction;
  private sendCommandRaw: SendCommandRawFunction;

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
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });
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
          `[VINRetriever] Error parsing hex pair: ${finalHex.substring(i, i + 2)}`,
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
    rawResponseBytes: number[][] | null | undefined, // Changed parameter type
  ): { error: string | null; rawString: string; cleanHex: string } {
    const result: {
      error: string | null;
      rawString: string;
      cleanHex: string;
    } = {
      error: null,
      rawString: '',
      cleanHex: '',
    };

    if (!rawResponseBytes || rawResponseBytes.length === 0) {
      result.error = 'No response received';
      return result;
    }

    try {
      // Combine byte arrays into a single string, preserving bytes using Latin1
      let combinedBytes: number[] = [];
      for (const byteArray of rawResponseBytes) {
        // Ensure byteArray is an array of numbers
        if (Array.isArray(byteArray)) {
          combinedBytes = combinedBytes.concat(byteArray);
        } else {
          // Handle potential unexpected format if necessary
          log.warn(
            '[VINRetriever] Unexpected format in rawResponseBytes:',
            byteArray,
          );
        }
      }
      result.rawString = String.fromCharCode(...combinedBytes);
    } catch (e) {
      log.error('[VINRetriever] Error combining/decoding rawResponseBytes', e);
      result.error = 'Byte array processing error';
      return result; // Cannot proceed if bytes are malformed
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
          `[VINRetriever] Received Negative Response (7F). Mode Echo: ${modeEcho}, NRC: ${nrc}`,
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
        `[VINRetriever] Received Potential Negative Response (NRC: ${nrc}). Pattern: ${potentialModeEcho} ${potentialPidEcho} ${nrc}. Full Hex: ${result.cleanHex}`,
      );
    }

    log.debug('[VINRetriever] checkResponseForErrors result:', {
      error: result.error,
      cleanHexLength: result.cleanHex.length,
    });
    return result;
  }

  private isValidCommandResponse(response: string | null): boolean {
    if (!response) return false;
    const cleaned = response.trim().toUpperCase();
    
    // Check if response ends with known success patterns
    return VIN_CONSTANTS.VALID_RESPONSES.some(valid => 
      cleaned.endsWith(valid) || 
      cleaned.includes(valid)
    );
  }

  private async initializeDevice(): Promise<boolean> {
    try {
      const state = ecuStore.getState();
      
      if (state.status !== 'CONNECTED' || state.activeProtocol !== 6) {
        log.warn('[VINRetriever] Not in CAN protocol or not connected', state);
        return false;
      }

      // Reset device
      await this.sendCommand('ATZ');
      await this.delay(VIN_CONSTANTS.DELAYS.INIT);

      // Initialize with mandatory sequence
      for (const { cmd, desc } of VIN_CONSTANTS.CAN_INIT_SEQUENCE) {
        const response = await this.sendCommand(cmd);
        if (!this.isValidCommandResponse(response)) {
          log.warn(`[VINRetriever] ${desc} failed:`, { cmd, response });
          // Continue anyway as some commands might return different responses
        }
        await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);
      }

      // Set header last
      if (state.selectedEcuAddress) {
        await this.sendCommand(`ATSH${state.selectedEcuAddress}`);
        await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);
      }

      return true;
    } catch (error) {
      log.error('[VINRetriever] Init failed:', error);
      return false;
    }
  }

  private async tryFlowControl(): Promise<ChunkedResponse | null> {
    // Simplified flow control sequence
    const flowConfigs = [
      { fcsd: '300000', desc: 'Standard' },
      { fcsd: '300100', desc: 'With Block Size' },
      { fcsd: '300004', desc: 'With ST' }
    ];

    for (const config of flowConfigs) {
      try {
        await this.sendCommand('ATFCSH7E8');
        await this.sendCommand(`ATFCSD${config.fcsd}`);
        await this.sendCommand('ATFCSM1');
        await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);

        log.debug(`[VINRetriever] Trying ${config.desc} flow control`);
        
        const response = await this.sendCommandRaw(VIN_CONSTANTS.COMMAND, {
          timeout: VIN_CONSTANTS.TIMEOUT
        });

        if (response?.rawResponse) {
          const { error } = this.checkResponseForErrors(response.rawResponse);
          if (!error || error.includes('7F0931')) {
            return response;
          }
        }
      } catch (error) {
        log.warn(`[VINRetriever] ${config.desc} flow control failed:`, error);
      }
      await this.delay(VIN_CONSTANTS.DELAYS.COMMAND);
    }
    return null;
  }

  public async retrieveVIN(): Promise<string | null> {
    try {
      if (!(await this.initializeDevice())) {
        return null;
      }

      // Try standard request first
      let response: ChunkedResponse | null = await this.sendCommandRaw(
        VIN_CONSTANTS.COMMAND,
      );

      // If no response or error, try with flow control
      if (
        !response?.rawResponse ||
        this.checkResponseForErrors(response.rawResponse).error
      ) {
        log.debug(
          '[VINRetriever] Initial request failed, trying with flow control',
        );
        const flowControlResponse = await this.tryFlowControl();
        if (flowControlResponse) {
          response = flowControlResponse;
        }
      }

      if (response?.rawResponse) {
        const processedVin = this.processVINResponse(response.rawResponse);
        if (processedVin && this.isValidVIN(processedVin)) {
          log.info('[VINRetriever] Successfully retrieved VIN:', processedVin);
          return processedVin;
        }
      }

      log.warn('[VINRetriever] Failed to retrieve valid VIN');
      return null;
    } catch (error) {
      log.error('[VINRetriever] VIN retrieval failed:', error);
      return null;
    }
  }

  /**
   * Processes the raw byte arrays from the adapter to extract the VIN string.
   * Handles multi-frame ISO-TP responses.
   */
  private processVINResponse(rawResponseBytes: number[][]): string | null {
    // Changed parameter type
    log.debug('[VINRetriever] Starting processVINResponse...');
    try {
      let combinedString = '';
      // Combine byte arrays into a single string using Latin1
      let combinedBytes: number[] = [];
      for (const byteArray of rawResponseBytes) {
        if (Array.isArray(byteArray)) {
          combinedBytes = combinedBytes.concat(byteArray);
        }
      }
      combinedString = String.fromCharCode(...combinedBytes);

      // Log the raw combined string (replace non-printable for clarity)
      log.debug(
        '[VINRetriever] processVINResponse - Combined Raw String:',
        // Replace non-printable ASCII characters instead of explicit control ranges
        combinedString.replace(/[^\x20-\x7E]/g, '.'),
      );

      const lines = combinedString.split(/[\r\n]+/);
      log.debug('[VINRetriever] processVINResponse - Split Lines:', lines);

      let assembledVINData = '';
      let isMultiFrameSequence = false;
      let expectedFrameIndex = 1;
      let totalVINLength = 0;

      // Expanded noise/status patterns to filter lines
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
        // Command echoes (might appear depending on ATE setting)
        /^0902/i,
        // Specific negative responses (e.g., 7F 09 XX)
        /^7F09/i,
        // ELM Version response
        /^ELM327/i,
        // Voltage response
        /^[0-9.]+V$/i,
      ];

      for (const line of lines) {
        let processedLine = line.trim();
        if (!processedLine) continue;

        // More aggressive noise check first (check the cleaned line)
        const cleanedForNoiseCheck = processedLine
          .replace(/\s/g, '')
          .toUpperCase();
        if (noisePatterns.some(pattern => pattern.test(cleanedForNoiseCheck))) {
          log.debug(
            '[VINRetriever] Discarding noise/status/error line:',
            processedLine,
          );
          continue;
        }

        // Remove ELM frame numbering (e.g., "0:", "1:") if present
        processedLine = processedLine.replace(/^\s*[0-9A-F]{1,2}:\s*/, '');
        const hexLine = processedLine.replace(/[^0-9A-F]/gi, '').toUpperCase(); // Keep only hex chars
        if (!hexLine) continue;

        // --- ISO-TP Frame processing ---
        // Find positive response marker 4902 (Mode 09, PID 02 response)
        const vinResponseStartIndex = hexLine.indexOf('4902');

        let dataPart: string; // Data portion of the frame

        if (!isMultiFrameSequence) {
          // If not in sequence, look for the start (SF or FF)
          if (vinResponseStartIndex === -1) {
            log.debug(
              '[VINRetriever] Discarding line without 4902 and not in active sequence:',
              hexLine,
            );
            continue; // Ignore lines before the positive response unless in sequence
          }
          // Extract data after 4902
          dataPart = hexLine.substring(vinResponseStartIndex + 4);
          const frameTypeNibble = dataPart.substring(0, 1);

          if (frameTypeNibble === '0') {
            // Single Frame (SF) - PCI: 0L DD...
            const length = parseInt(dataPart.substring(1, 2), 16);
            if (
              !isNaN(length) &&
              length > 0 &&
              dataPart.length >= 2 + length * 2
            ) {
              assembledVINData = dataPart.substring(2, 2 + length * 2); // Extract specific length
              log.debug(
                `[VINRetriever] Found Single Frame (SF). Length: ${length}, Data: ${assembledVINData}`,
              );
              break; // SF is a complete message
            } else {
              log.warn('[VINRetriever] Invalid Single Frame format:', {
                dataPart,
              });
              return null; // Invalid SF
            }
          } else if (frameTypeNibble === '1') {
            // First Frame (FF) - PCI: 1LLL DD...
            const lengthHex = dataPart.substring(1, 4); // 12 bits length
            totalVINLength = parseInt(lengthHex, 16);
            if (
              isNaN(totalVINLength) ||
              totalVINLength <= 7 ||
              dataPart.length < 4
            ) {
              // Must be > 7 for MF
              log.warn('[VINRetriever] Invalid First Frame format or length:', {
                dataPart,
                totalVINLength,
              });
              return null; // Invalid FF
            }
            isMultiFrameSequence = true;
            expectedFrameIndex = 1;
            assembledVINData = dataPart.substring(4); // Initial data
            log.debug(
              `[VINRetriever] Found First Frame (FF). Expected Length: ${totalVINLength}, Initial Data: ${assembledVINData}`,
            );
          } else {
            // Response started with 4902 but not SF or FF - maybe single chunk data without ISO-TP?
            log.debug(
              '[VINRetriever] Response starts with 4902 but not SF/FF. Treating as single data chunk:',
              { dataPart },
            );
            assembledVINData = dataPart;
            break; // Assume complete
          }
        } else {
          // --- Currently in a multi-frame sequence ---
          dataPart = hexLine; // Use the whole hex line as potential data
          const frameTypeNibble = dataPart.substring(0, 1);

          if (frameTypeNibble === '2') {
            // Consecutive Frame (CF) - PCI: 2N DD...
            const sequenceNumber = parseInt(dataPart.substring(1, 2), 16);
            if (isNaN(sequenceNumber)) {
              log.warn(
                '[VINRetriever] Invalid Consecutive Frame sequence number:',
                { dataPart },
              );
              isMultiFrameSequence = false;
              assembledVINData = '';
              continue; // Invalid CF, reset sequence
            }
            if (sequenceNumber !== expectedFrameIndex % 16) {
              log.warn(
                `[VINRetriever] Unexpected CF sequence. Expected ${expectedFrameIndex % 16}, got ${sequenceNumber}. Frame: ${dataPart}. Resetting sequence.`,
              );
              isMultiFrameSequence = false;
              assembledVINData = '';
              continue; // Sequence error, reset sequence
            }
            assembledVINData += dataPart.substring(2); // Append data
            expectedFrameIndex++;
            log.debug(
              `[VINRetriever] Found Consecutive Frame (CF). Sequence: ${sequenceNumber}, Appended Data: ${dataPart.substring(2)}`,
            );
          } else if (frameTypeNibble === '3') {
            // Flow Control (FC) - PCI: 3S BS ST
            log.debug('[VINRetriever] Ignoring Flow Control Frame (FC):', {
              dataPart,
            });
            // Do nothing, just ignore this frame
          } else {
            log.warn(
              '[VINRetriever] Unexpected frame type received during multi-frame sequence:',
              { dataPart },
            );
            // Decide how to handle: ignore frame, reset sequence? Let's reset.
            isMultiFrameSequence = false;
            assembledVINData = '';
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
            `[VINRetriever] Multi-frame message complete. Expected ${totalVINLength} bytes, received ${assembledVINData.length / 2}.`,
          );
          assembledVINData = assembledVINData.substring(0, totalVINLength * 2); // Trim any excess
          break; // Message complete
        }
      } // End line processing loop

      if (!assembledVINData) {
        log.warn(
          '[VINRetriever] No valid VIN data could be assembled from the response.',
        );
        return null;
      }
      log.debug('[VINRetriever] Assembled VIN Hex:', assembledVINData);

      // ISO-TP data part for VIN should contain the VIN ASCII bytes.
      // The standard VIN response is usually prefixed by a byte indicating the number of data items (usually 01 for VIN)
      // Example: 01<17 bytes of VIN ASCII>
      // Check if the first byte looks like a count (e.g., 01)
      let vinHex = assembledVINData;
      if (assembledVINData.startsWith('01') && assembledVINData.length >= 36) {
        // 01 + 17 bytes * 2 hex chars = 36
        log.debug(
          '[VINRetriever] Detected potential VIN count prefix (01), removing.',
        );
        vinHex = assembledVINData.substring(2); // Skip the '01'
      }

      // Ensure we have exactly 17 bytes (34 hex chars) for VIN
      if (vinHex.length < 34) {
        log.warn(
          `[VINRetriever] Assembled VIN hex data too short (${vinHex.length} hex chars). Expected 34. Data: ${vinHex}`,
        );
        return null;
      }
      if (vinHex.length > 34) {
        log.debug(
          '[VINRetriever] Assembled VIN hex data longer than 34 chars, taking first 34.',
          { vinHex },
        );
        vinHex = vinHex.substring(0, 34);
      }

      const vin = this.hexToAscii(vinHex);
      log.debug('[VINRetriever] Parsed VIN String:', vin);

      if (this.isValidVIN(vin)) {
        log.info('[VINRetriever] Valid VIN found:', vin);
        return vin;
      } else {
        log.warn('[VINRetriever] Parsed string is not valid VIN format.', {
          vin,
        });
        return null;
      }
    } catch (error: unknown) {
      log.error('[VINRetriever] Error processing VIN response:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }
}
