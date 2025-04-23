// filepath: src/ecu/retrievers/VINRetriever.ts
import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';
import { DELAYS_MS, RESPONSE_KEYWORDS, ELM_COMMANDS } from '../utils/constants';
import { cleanResponse, isResponseError } from '../utils/helpers';

import type {
  SendCommandFunction,
  SendCommandRawFunction, // Import the correct type
  ChunkedResponse,        // Import the correct type
} from '../utils/types';

export class VINRetriever {
  private sendCommand: SendCommandFunction;
  private sendCommandRawChunked: SendCommandRawFunction; // Use the correct function type

  constructor(
    sendCommand: SendCommandFunction,
    sendCommandRawChunked: SendCommandRawFunction, // Update parameter type
  ) {
    if (!sendCommand) {
      throw new Error('VINRetriever requires the standard sendCommand function for configuration.');
    }
    if (!sendCommandRawChunked) {
      throw new Error('VINRetriever requires the sendCommandRawChunked function.');
    }
    this.sendCommand = sendCommand;
    this.sendCommandRawChunked = sendCommandRawChunked; // Assign the function
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    });
  }

  private bytesToHex(bytes: Uint8Array): string {
    // Ensure input is Uint8Array before processing
     if (!(bytes instanceof Uint8Array)) {
        log.warn('[VINRetriever] bytesToHex received non-Uint8Array:', bytes);
        // Attempt conversion if possible, otherwise return empty
        try {
            bytes = new Uint8Array(Object.values(bytes));
        } catch {
            return '';
        }
    }
    return Array.from(bytes)
      .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
      .join('');
  }

  private hexToAscii(hex: string): string {
    let str = '';
    // Ensure hex string length is even
    const cleanHex = hex.length % 2 !== 0 ? hex.slice(0, -1) : hex;
    for (let i = 0; i < cleanHex.length; i += 2) {
        try {
            const charCode = parseInt(cleanHex.substring(i, i + 2), 16);
            if (isNaN(charCode)) continue; // Skip if not a valid number
            // Filter out non-printable ASCII characters except space
            if (charCode >= 32 && charCode <= 126) {
                 str += String.fromCharCode(charCode);
            }
        } catch (e) {
            log.warn(`[VINRetriever] Error parsing hex pair: ${cleanHex.substring(i, i + 2)}`, e);
        }
    }
    return str.trim();
  }


  private isValidVIN(vin: string): boolean {
    return /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin);
  }

  // Enhanced error checking
  private checkResponseForErrors(
    chunks: Uint8Array[] | null | undefined
  ): { error: string | null; rawString: string; cleanHex: string } { // Allow string | null for error
    // Initialize error as null, but allow string assignment later
    const result: { error: string | null; rawString: string; cleanHex: string } = {
        error: null,
        rawString: '',
        cleanHex: ''
    };
    if (!chunks || chunks.length === 0) {
      result.error = 'No response received'; // This assignment is now valid
      return result;
    }

    try {
        for (const chunk of chunks) {
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(Object.values(chunk));
            // Use Latin1 (ISO-8859-1) for decoding to preserve byte values
            result.rawString += String.fromCharCode(...bytes);
        }
    } catch (e) {
         log.error('[VINRetriever] Error combining/decoding chunks', e);
         result.error = 'Chunk processing error'; // This assignment is now valid
         return result; // Cannot proceed if chunks are malformed
    }


    // Basic cleaning for error checking (remove prompt, normalize whitespace)
    const basicCleaned = result.rawString.replace(/[>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
    result.cleanHex = basicCleaned.replace(/\s/g, '').toUpperCase(); // Hex string without spaces

    // --- Specific Error Checks ---
    if (isResponseError(basicCleaned)) { // Use helper which checks common ELM errors
        if (basicCleaned.includes(RESPONSE_KEYWORDS.TIMEOUT)) result.error = 'Timeout'; // Valid
        else if (basicCleaned.includes(RESPONSE_KEYWORDS.BUFFER_FULL)) result.error = 'Buffer Full'; // Valid
        else if (basicCleaned.includes(RESPONSE_KEYWORDS.NO_DATA)) result.error = 'No Data'; // Valid
        // General Negative Response check (7F XX XX)
        else if (result.cleanHex.startsWith('7F')) {
             // Try to extract Mode Echo and NRC more carefully
             const modeEcho = result.cleanHex.substring(2, 4);
             const nrc = result.cleanHex.substring(4, 6);
             result.error = `Negative Response (Mode Echo: ${modeEcho}, NRC: ${nrc})`; // Valid
        }
        else result.error = `General Error (${basicCleaned})`; // Valid
    }
     // Check for empty response (just prompt)
    else if (basicCleaned === RESPONSE_KEYWORDS.PROMPT || basicCleaned === '') {
        result.error = 'Empty response'; // Valid
    }

    log.debug('[VINRetriever] checkResponseForErrors result:', { error: result.error, cleanHexLength: result.cleanHex.length });
    return result;
  }


  private async tryFlowControlAndRetryVIN(): Promise<ChunkedResponse | null> {
    // ...(Keep the tryFlowControlAndRetryVIN function from the previous answer)
        log.debug('[VINRetriever] Initial VIN request failed or returned error. Attempting Flow Control adjustments...');
    const ecuResponseHeader = '7E8'; // TODO: Make dynamic if needed

    const flowControlConfigs = [
      { fcsh: ecuResponseHeader, fcsd: '300000', fcsm: '1', desc: 'Standard (BS=0, ST=0, Mode=1)' },
      { fcsh: ecuResponseHeader, fcsd: '300000', fcsm: '0', desc: 'No Wait (BS=0, ST=0, Mode=0)' },
      { fcsh: ecuResponseHeader, fcsd: '300008', fcsm: '1', desc: 'Extended Wait (BS=0, ST=8ms, Mode=1)' },
    ];

    for (const config of flowControlConfigs) {
      log.debug(`[VINRetriever] Trying Flow Control: ${config.desc}`);
      try {
        const fcshCmd = `${ELM_COMMANDS.CAN_FLOW_CONTROL_HEADER}${config.fcsh}`;
        const fcsdCmd = `${ELM_COMMANDS.CAN_FLOW_CONTROL_DATA}${config.fcsd}`;
        const fcsmCmd = `${ELM_COMMANDS.CAN_FLOW_CONTROL_MODE}${config.fcsm}`;
        let fcOk = true;

        for(const cmd of [fcshCmd, fcsdCmd, fcsmCmd]){
            const fcResponse = await this.sendCommand(cmd, { timeout: 2000 });
             if (fcResponse === null || isResponseError(fcResponse)) {
                 log.warn(`[VINRetriever] Flow control command "${cmd}" failed. Response: ${fcResponse ?? 'null'}`);
                 fcOk = false; break;
             }
             await this.delay(DELAYS_MS.COMMAND_SHORT);
        }
        if(!fcOk) continue;

        log.debug('[VINRetriever] Retrying 0902 command with new FC settings...');
        // Call the function correctly, it returns Promise<ChunkedResponse>
        const retryResponse: ChunkedResponse | null = await this.sendCommandRawChunked('0902', { timeout: 15000 });
        // Check if retryResponse is not null before accessing chunks
        const { error: retryError } = this.checkResponseForErrors(retryResponse?.chunks);

        if (retryResponse && !retryError) {
          log.info(`[VINRetriever] Flow control adjustment successful with: ${config.desc}`);
          // Return the ChunkedResponse object
          return retryResponse;
        } else {
           log.debug(`[VINRetriever] Flow control config (${config.desc}) did not yield valid response on retry. Error: ${retryError ?? 'Unknown'}`);
        }
      } catch (error) {
        log.warn(`[VINRetriever] Error during Flow Control config attempt (${config.desc}):`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
       await this.delay(DELAYS_MS.COMMAND_MEDIUM);
    }
    log.warn('[VINRetriever] Could not retrieve VIN after trying all Flow Control configurations.');
    return null;
  }


  private processVINResponse(chunks: Uint8Array[]): string | null {
    // ...(Keep the robust processVINResponse function from the previous answer, maybe add more logging)
    // Add extra logging inside this function if needed
    log.debug("[VINRetriever] Starting processVINResponse...");
    try {
        let combinedString = '';
        for (const chunk of chunks) {
             // Ensure chunk is Uint8Array before processing
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(Object.values(chunk));
            // Decode using Latin1 (ISO-8859-1) to preserve raw bytes
            combinedString += String.fromCharCode(...bytes);
        }

        log.debug('[VINRetriever] processVINResponse - Combined Raw String:', combinedString.replace(/[\x00-\x1F\x7F-\xFF]/g, '.'));

        const lines = combinedString.split(/[\r\n]+/);
        log.debug('[VINRetriever] processVINResponse - Split Lines:', lines);

        let assembledVINData = '';
        let isMultiFrameSequence = false;
        let expectedFrameIndex = 1;
        let totalVINLength = 0;

        // Expanded noise patterns
        const noisePatterns = [
            /^AT/i, /^OK/i, /^\?/, /^>/, /^SEARCHING/i, /^BUS INIT/i,
            /^STOPPED/i, /^NO DATA/i, /^ERROR/i,
            // Specific negative responses seen:
            /^7F 01 31/i, // From logs
            /^7F 09 11/i, // Service not supported
            /^7F 09 12/i, // Sub-function not supported
            /^7F 09 22/i, // Conditions not correct
            /^7F 09 31/i, // Request out of range (explicitly handled below too)
            // Command echoes:
            /^0100/i, /^0902/i,
        ];

        for (const line of lines) {
            let processedLine = line.trim();
            if (!processedLine) continue;

             // More aggressive noise check first
             if (noisePatterns.some(pattern => pattern.test(processedLine.replace(/\s/g, '')))) { // Check without spaces too
                log.debug('[VINRetriever] Discarding noise/status/error line:', processedLine);
                continue;
            }


             // Handle trailing '62' potentially
            if (processedLine.endsWith('62')) {
                const without62 = processedLine.slice(0, -2).trim();
                 // Only remove if it leaves something meaningful potentially
                if (without62.length > 0 && (without62.includes('4902') || /^[0-9A-F\s]+$/i.test(without62))) {
                   processedLine = without62;
                }
            }

            processedLine = processedLine.replace(/^\s*[0-9A-F]{1,2}:\s*/, ''); // Remove frame numbering
            const hexLine = processedLine.replace(/\s/g, '').toUpperCase();
            if (!hexLine) continue;

            // Explicit Negative response check FIRST
            if (hexLine.startsWith('7F')) {
                const modeEcho = hexLine.substring(2, 4);
                const nrc = hexLine.substring(4, 6);
                log.warn(`[VINRetriever] Received Negative Response during parsing. Mode Echo: ${modeEcho}, NRC: ${nrc}`);
                return null; // Stop parsing on negative response
            }

            // Find positive response marker 4902
            const vinResponseStartIndex = hexLine.indexOf('4902');
            if (vinResponseStartIndex === -1 && !isMultiFrameSequence) {
                log.debug('[VINRetriever] Discarding line without 4902 or active sequence:', hexLine);
                continue;
            }

            let dataPart = isMultiFrameSequence ? hexLine : hexLine.substring(vinResponseStartIndex + 4);
            const frameTypeNibble = dataPart.substring(0, 1);

             // ISO-TP Frame processing (same as before)
            if (frameTypeNibble === '0' && !isMultiFrameSequence) { /* SF handling */
                 const length = parseInt(dataPart.substring(1, 2), 16);
                 if (!isNaN(length) && length > 0) {
                     assembledVINData = dataPart.substring(2, 2 + length * 2); break; // Assume SF is complete
                 } else { return null; } // Invalid SF
            }
            else if (frameTypeNibble === '1' && !isMultiFrameSequence) { /* FF handling */
                const lengthHex = dataPart.substring(1, 4); totalVINLength = parseInt(lengthHex, 16);
                if (isNaN(totalVINLength) || totalVINLength === 0) { return null; } // Invalid FF
                isMultiFrameSequence = true; expectedFrameIndex = 1; assembledVINData = dataPart.substring(4);
            }
            else if (frameTypeNibble === '2' && isMultiFrameSequence) { /* CF handling */
                const sequenceNumber = parseInt(dataPart.substring(1, 2), 16);
                if (isNaN(sequenceNumber)) { isMultiFrameSequence = false; assembledVINData = ''; continue; } // Invalid CF
                if (sequenceNumber !== expectedFrameIndex % 16) { isMultiFrameSequence = false; assembledVINData = ''; continue; } // Sequence error
                assembledVINData += dataPart.substring(2); expectedFrameIndex++;
            }
            else if (frameTypeNibble === '3') { /* FC handling - ignore */ }
            else if (!isMultiFrameSequence && vinResponseStartIndex !== -1) { /* Single chunk data */
                assembledVINData = dataPart; break;
            }
            else { /* Unrecognized */ log.debug('[VINRetriever] Discarding unrecognized data line:', hexLine); }


            // Check completion
            if (isMultiFrameSequence && totalVINLength > 0 && assembledVINData.length >= totalVINLength * 2) {
                assembledVINData = assembledVINData.substring(0, totalVINLength * 2); break;
            }
        } // End line processing loop

        if (!assembledVINData) {
            log.warn('[VINRetriever] No VIN data could be assembled.'); return null;
        }
        log.debug('[VINRetriever] Assembled VIN Hex:', assembledVINData);

        if (assembledVINData.length < 34) {
            log.warn(`[VINRetriever] Assembled VIN data too short (${assembledVINData.length} hex chars).`); return null;
        }

        const vinHex = assembledVINData.substring(0, 34);
        const vin = this.hexToAscii(vinHex);
        log.debug('[VINRetriever] Parsed VIN String:', vin);

        if (this.isValidVIN(vin)) {
            log.info('[VINRetriever] Valid VIN found:', vin); return vin;
        } else {
            log.warn('[VINRetriever] Parsed string is not valid VIN.', { vin }); return null;
        }

    } catch (error: unknown) {
        log.error('[VINRetriever] Error processing VIN response:', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
        });
        return null;
    }
  }


  public async retrieveVIN(): Promise<string | null> {
    try {
      log.debug('[VINRetriever] Sending initial VIN request (0902)...');
      // Type response correctly based on the function's return type
      let response: ChunkedResponse | null = await this.sendCommandRawChunked('0902', { timeout: 15000 });

      // Log initial chunks received for debugging
      if (response?.chunks) {
            log.debug(`[VINRetriever] Received initial ${response.chunks.length} chunks for 0902.`);
            response.chunks.forEach((chunk, index) => {
                const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(Object.values(chunk));
                log.debug(`[VINRetriever] Initial Chunk ${index} Hex:`, this.bytesToHex(bytes));
                log.debug(`[VINRetriever] Initial Chunk ${index} ASCII:`, String.fromCharCode(...bytes).replace(/[\x00-\x1F\x7F-\xFF]/g, '.'));
            });
            // Log the combined raw string from initial check
            const { rawString: initialRawStringForLog } = this.checkResponseForErrors(response?.chunks);
            log.debug('[VINRetriever] Initial Raw String Combined:', initialRawStringForLog.replace(/[\x00-\x1F\x7F-\xFF]/g, '.'));
      } else {
           log.warn('[VINRetriever] No initial chunks received for 0902.');
           // Consider triggering FC retry even on no response? Or just fail? Let's fail for now.
           return null;
      }

      // Access chunks safely using optional chaining
      const { error: initialError, rawString: initialRawString } = this.checkResponseForErrors(response?.chunks);
      log.debug('[VINRetriever] Initial response check result:', { initialError });


       if (initialError) {
          log.warn(`[VINRetriever] Initial 0902 request failed or returned error: ${initialError}.`);
          // Determine if FC retry is warranted based on the error type
          const retryFCErrors = ['Timeout', 'Buffer Full', 'Negative Response (NRC: 31)', 'Negative Response (NRC: 22)']; // Add NRC 22?
          const isRetryableError = retryFCErrors.some(e => initialError.includes(e));

          if (isRetryableError) {
                log.debug('[VINRetriever] Triggering Flow Control retry due to error:', initialError);
                // tryFlowControlAndRetryVIN now returns Promise<ChunkedResponse | null>
                response = await this.tryFlowControlAndRetryVIN();
                if (!response) {
                   log.error('[VINRetriever] VIN retrieval failed even after Flow Control adjustments.');
                   return null; // FC retry also failed
                }
                log.info('[VINRetriever] Flow Control retry yielded a response.');
          } else {
              log.debug('[VINRetriever] Skipping Flow Control retry because error is considered definitive:', initialError);
              return null; // Initial definitive failure
          }
       }

      // If we have a response (either initial or after FC retry)
      // Check response is not null before accessing chunks
      if (response?.chunks) {
        log.debug(`[VINRetriever] Processing final ${response.chunks.length} chunks for VIN.`);
        // Log final chunks if they came from retry
         if (initialError) { // Only log again if we retried
            response.chunks.forEach((chunk, index) => {
                const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(Object.values(chunk));
                log.debug(`[VINRetriever] Final Chunk ${index} Hex:`, this.bytesToHex(bytes));
                log.debug(`[VINRetriever] Final Chunk ${index} ASCII:`, String.fromCharCode(...bytes).replace(/[\x00-\x1F\x7F-\xFF]/g, '.'));
            });
         }
         console.log('LOG Final Response Object to Parse:', JSON.stringify(response, (key, value) =>
           value instanceof Uint8Array ? Array.from(value) : value, 2) // Log final structure
         );

        // Process the potentially successful response's chunks
        const vin = this.processVINResponse(response.chunks);
        if (vin) {
          // VIN successfully parsed
          return vin;
        } else {
           log.warn('[VINRetriever] Failed to parse VIN from the final response chunks.');
           return null;
        }
      }

      // If response was null even after potential retries
      log.warn('[VINRetriever] No valid response chunks available after all attempts.');
      return null;

    } catch (error: unknown) {
      log.error('[VINRetriever] Uncaught Error during VIN retrieval process:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

}