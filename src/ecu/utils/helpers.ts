import { log } from '../../utils/logger'; // Use project logger

import { RESPONSE_KEYWORDS, PROTOCOL } from './constants';
import { hexToBytes, bytesToString } from './ecuUtils';

/**
 * Cleans ELM327 response string more aggressively.
 * Removes prompt (>), ELM ID (ELM327), OK, SEARCHING..., whitespace, control chars.
 * Keeps data-related parts like hex values and potentially meaningful keywords (NO DATA, ERROR).
 * Based on ElmProtocolInit.getResponseId and cleaning logic in JS files.
 */
export const cleanResponse = (response: string | null | undefined): string => {
  if (!response) return '';

  // Remove common ELM status messages, prompt, control chars, trim aggressively
  // Keep ELM ID for now? Some logic might depend on it.
  // Don't remove OK yet, isResponseOk uses it.
  return (
    response
      .replace(/>/g, '') // Prompt
      .replace(/SEARCHING\.\.\./i, '') // Searching...
      // Remove specific command echos if present and echo wasn't disabled properly
      .replace(/^ATZ[\r\n]*/i, '')
      .replace(/^ATE0[\r\n]*/i, '')
      .replace(/^ATL0[\r\n]*/i, '')
      .replace(/^ATS0[\r\n]*/i, '')
      .replace(/^ATH[01][\r\n]*/i, '')
      .replace(/^ATSP[0-9A-F][\r\n]*/i, '')
      .replace(/^ATTP[0-9A-F][\r\n]*/i, '')
      .replace(/^ATRV[\r\n]*/i, '')
      // Remove control characters AFTER potentially useful keywords are checked
      .replace(/[\r\n\t\0]/g, ' ') // Replace control chars with space to avoid merging hex
      .replace(/\s+/g, ' ') // Normalize whitespace to single space
      .trim() // Leading/trailing whitespace
      .toUpperCase()
  ); // Standardize to uppercase
};

/**
 * Checks if the response from the OBD device indicates a successful command execution
 * @param response The response string from the OBD device
 * @returns true if the response contains 'OK' or valid data
 */
export const isResponseOk = (response: string): boolean => {
  if (!response) return false;
  const cleanedResponse = response.trim().toUpperCase();
  return cleanedResponse === 'OK' || /^[0-9A-F\s]+$/.test(cleanedResponse);
};

/**
 * Checks for common *ELM* error keywords in the response using constants.
 * Does *not* check for OBD "NO DATA" as an error by default here.
 * Based on ElmProtocolInit.isErrorResponse and ERROR_RESPONSES list in BaseDTCRetriever.
 */
export const isResponseError = (
  response: string | null | undefined,
): boolean => {
  if (response === null) return true; // Treat null (timeout/no comms) as an error
  if (!response) return false; // Treat empty string as non-error

  // Standardize response for matching: remove spaces, uppercase
  const cleanedUpper = response.replace(/\s/g, '').toUpperCase();
  if (cleanedUpper.length === 0) return false; // Empty after cleaning is not error

  // Check against known error patterns defined in BaseDTCRetriever
  // Intentionally exclude NO_DATA from this check, as it's a valid response type
  const errorKeywords = [
    RESPONSE_KEYWORDS.ERROR,
    RESPONSE_KEYWORDS.UNABLE_TO_CONNECT.replace(/\s/g, ''),
    RESPONSE_KEYWORDS.BUS_INIT.replace(/\s/g, ''),
    RESPONSE_KEYWORDS.CAN_ERROR.replace(/\s/g, ''),
    RESPONSE_KEYWORDS.BUS_ERROR.replace(/\s/g, ''),
    RESPONSE_KEYWORDS.FB_ERROR.replace(/\s/g, ''),
    RESPONSE_KEYWORDS.DATA_ERROR.replace(/\s/g, ''),
    RESPONSE_KEYWORDS.BUFFER_FULL.replace(/\s/g, ''),
    RESPONSE_KEYWORDS.RX_ERROR.replace(/\s/g, ''), // '<'
    RESPONSE_KEYWORDS.STOPPED,
    RESPONSE_KEYWORDS.TIMEOUT, // Explicit TIMEOUT check
    '7F', // Negative response code
    'UNABLE', // Partial match
    'ACT ALERT', // From JS
    'ERR', // From JS
    // Removed 'NO DATA' from error check here
  ].map(e => e.replace(/\s/g, '').toUpperCase());

  // Specific check for "?" response which indicates ELM command error
  if (response.trim() === RESPONSE_KEYWORDS.QUESTION_MARK) {
    return true;
  }

  // Check if the cleaned response contains any error keyword
  if (errorKeywords.some(keyword => cleanedUpper.includes(keyword))) {
    return true;
  }

  return false;
};

/**
 * Extracts voltage if present in response (e.g., "12.3V").
 * Based on logic in connectionService.
 */
export const extractVoltage = (
  response: string | null | undefined,
): string | null => {
  if (!response) return null;

  // Clean less aggressively for voltage as format is specific "ATRV -> 12.3V"
  const cleaned = response.replace(/[>\r\n\t\0]/g, ''); // Remove prompt/control chars, keep spaces initially
  // Match pattern like "12.3V" or "12V", possibly surrounded by spaces or other chars
  // Ensure it captures the full number and 'V'
  const match = cleaned.match(/(\d{1,2}(?:\.\d{1,2})?V)/i);

  return match?.[1] ? match[1].toUpperCase() : null; // Return the first captured group (the voltage string)
};

/**
 * Extracts protocol number from ATDPN response (e.g., "A6" -> 6, "3" -> 3).
 * Based on logic in ProtocolManager.
 */
export const extractProtocolNumber = (
  response: string | null | undefined,
): number | null => {
  if (!response) return null;

  // Clean response: remove prompt, whitespace, control characters
  // Handle potential "USER1", "USER2", "SAE J1939" text responses? ELM usually gives number.
  const cleaned = response.replace(/[>\r\n\t\0\s]/g, '').toUpperCase();

  // Match optional 'A' followed by one or two hex digits (for protocols A,B,C which are 10,11,12)
  // Allow protocols up to 20 (14 hex)
  const match = cleaned.match(/^(A?)([0-9A-F]{1,2})$/i);

  if (match) {
    const isAuto = match[1] === 'A'; // Check if it was auto-detected ('A' prefix)
    const protocolHex = match[2];
    try {
      const parsedProtocol = protocolHex ? parseInt(protocolHex, 16) : null;
      // Validate against known range (0 to 20)
      if (
        parsedProtocol !== null &&
        parsedProtocol >= PROTOCOL.AUTO &&
        parsedProtocol <= PROTOCOL.ISO_15765_4_CAN_29BIT_250K_8
      ) {
        // Log if it was auto-detected
        if (isAuto) {
          void log.debug(
            `[Helper] Auto-detected protocol number: ${parsedProtocol} (from ${response})`,
          );
        }
        return parsedProtocol;
      } else {
        void log.warn(
          `[Helper] Extracted protocol number out of expected range: ${parsedProtocol} from ${response}`,
        );
      }
    } catch (error: unknown) {
      // Catch parsing errors
      const errorMsg = error instanceof Error ? error.message : String(error);
      void log.error(
        `[Helper] Failed to parse protocol number from ${protocolHex} in ${response}`,
        { error: errorMsg },
      );
    }
  } else {
    // Check for text responses (less common for ATDPN)
    if (cleaned.includes('J1850PWM')) return PROTOCOL.SAE_J1850_PWM;
    if (cleaned.includes('J1850VPW')) return PROTOCOL.SAE_J1850_VPW;
    if (cleaned.includes('ISO9141')) return PROTOCOL.ISO_9141_2;
    if (cleaned.includes('KWP')) return PROTOCOL.ISO_14230_4_KWP_FAST; // Assume fast KWP
    if (cleaned.includes('CAN')) {
      // Default to common CAN if specific type not identifiable
      return PROTOCOL.ISO_15765_4_CAN_11BIT_500K;
    }
  }
  // No valid protocol found
  return null;
};

/**
 * Extracts potential ECU addresses (CAN/ISO/KWP headers) from a response string.
 * Can handle multi-line responses. Returns a unique list of found addresses.
 * Combines logic from ElmProtocolHelper.extractEcuAddress and connectionService.extractEcuAddresses.
 * Prioritizes headers appearing at the start of a line or after a frame number (e.g., 0:, 1:).
 */
export function extractEcuAddresses(
  rawResponse: string | null | undefined,
): string[] {
  if (!rawResponse) return [];

  const addresses = new Set<string>();
  // Split by newline or carriage return, filter empty lines
  const lines = rawResponse
    .split(/[\r\n]+/)
    .filter(line => line.trim().length > 0);

  for (const line of lines) {
    let dataPart = line.trim().toUpperCase(); // Work with uppercase hex

    // Remove ELM's optional line/frame numbering (e.g., "0:", "1:") if present
    dataPart = dataPart.replace(/^\s*[0-9A-F]{1,2}:\s*/, '');

    // Check if the remaining part is just hex data or known non-header keywords
    if (
      !/^[0-9A-F\s]+$/.test(dataPart) ||
      dataPart === RESPONSE_KEYWORDS.OK ||
      dataPart === RESPONSE_KEYWORDS.NO_DATA ||
      isResponseError(dataPart)
    ) {
      continue; // Skip lines that are not hex data or are known status messages
    }

    // Remove potential response codes like 41, 43, 49 etc. before header checks? Risky.
    // Let's try matching headers directly.

    // --- CAN Header Detection ---
    // Match 11-bit CAN header (7E8-7EF) at the start, must be followed by data
    let match = dataPart.match(/^(7E[89ABCDEF])([0-9A-F]{2})/i); // Ensure data follows header
    if (match?.[1] && match[2]) {
      addresses.add(match[1]); // Add the full 7Ex header
      continue; // Prioritize this match for the line
    }

    // Match 29-bit CAN header (18DA F1 xx or 18DB 33 F1) at the start
    // Look for 18DA followed by F1 (tester) and xx (ECU) -> 18DAF1xx
    match = dataPart.match(/^(18DAF1[0-9A-F]{2})/i); // Physical response
    if (match?.[1] && dataPart.length > match[1].length) {
      addresses.add(match[1]); // Add the full 18DAF1xx header
      continue;
    }
    // Look for 18DA followed by xx (ECU) and F1 (tester) -> 18DAxxF1 (less common but possible)
    match = dataPart.match(/^(18DA[0-9A-F]{2}F1)/i);
    if (match?.[1] && dataPart.length > match[1].length) {
      addresses.add(match[1]); // Add the full 18DAxxF1 header
      continue;
    }
    // Look for functional addressing response 18DB33F1 (often used for requests, less for responses)
    match = dataPart.match(/^(18DB33F1)/i); // Functional addressing
    if (match?.[1] && dataPart.length > match[1].length) {
      // Don't typically add functional address as ECU address unless no physical found
      // addresses.add(match[1]);
      continue;
    }

    // --- ISO/KWP Header Detection (typically 3 bytes: Format/Target, Target/Source, Source/Length or Data) ---
    // Examples: 48 6B 11 (ISO), 81 F1 11 (KWP Addr), 68 6A F1 (KWP Fmt)
    // We usually want the Source address (ECU address, often F1 for tester, 10/11/etc for ECU)
    match = dataPart.match(/^([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})/i);
    if (match?.[1] && match[2] && match[3]) {
      const formatTarget = match[1];
      const targetSource = match[2];
      const sourceLengthOrData = match[3];

      // ISO 9141-2 (e.g., 48 6B 11): Source is often the 3rd byte
      if (formatTarget === '48' && targetSource === '6B') {
        addresses.add(sourceLengthOrData);
        continue;
      }
      // KWP (e.g., 68 6A F1 or 81 F1 11): Source is often F1 (tester), Target is 2nd byte
      // So the ECU address might be in the 2nd byte (targetSource) if format indicates addressing (e.g., 8x)
      // Or the 3rd byte (sourceLengthOrData) if format indicates target/source/length (e.g., 6x)
      if (formatTarget.startsWith('8')) {
        // Addressing format
        addresses.add(targetSource); // ECU is likely Target
        continue;
      }
      if (formatTarget.startsWith('4') || formatTarget.startsWith('6')) {
        // Message format
        if (targetSource !== 'F1') {
          // If target is not the tester, it might be the ECU
          addresses.add(targetSource);
        } else if (sourceLengthOrData !== 'F1') {
          // If source is not the tester, it might be the ECU
          addresses.add(sourceLengthOrData);
        }
        continue;
      }
    }

    // --- Fallback for Headers Off ---
    // If headers are off (ATH0), the response might start directly with the service byte (e.g., 41, 43, 49)
    // In this case, we cannot reliably determine the ECU address from the response itself.
    // Do not add anything in this case.
  }

  // Convert Set to Array before returning
  return Array.from(addresses);
}

// --- Functions below are related to VIN/DTC parsing ---
// --- Keep implementation as-is per instructions, focus only on ensuring types/logging ---

/**
 * Checks if a cleaned response line looks like a VIN multi-frame indicator.
 * (Unchanged from connectionService - keep as is)
 */
export const isVinResponseFrame = (cleanedResponse: string): boolean => {
  // Check for standard ISO 15765-4 multi-frame indicators
  // 10 LL ... -> First Frame (xx = length, L = first nibble of length)
  // 2N ...    -> Consecutive Frame (N = sequence number 0-F)
  // These indicators appear *after* the service/PID (e.g., 49 02 01 ...)
  // So we look for them *after* the initial part of the response
  const dataPart = cleanedResponse.replace(/^(4902|0902)/, '').trim(); // Remove service/PID prefix
  return (
    dataPart.startsWith('10') || // First Frame (type 1, length follows)
    /^[2][0-9A-F]/.test(dataPart) // Consecutive Frame (type 2, sequence follows)
  );
};

/**
 * Assembles data from a potentially multi-line/multi-frame ELM response.
 * Removes frame counters (like '0:', '1:'), ISO-TP indicators (like '10xx', '2x'), prompts, whitespace.
 * Assumes the input `rawResponse` contains all frames concatenated by newlines/CRs.
 * (Unchanged from connectionService - keep as is, added logging)
 */
export const assembleMultiFrameResponse = (
  rawResponse: string | null | undefined,
): string => {
  if (!rawResponse) return '';

  void log.debug(`[Helper:assemble] Input: ${rawResponse}`); // Use logger
  // Split by newline or carriage return, filter empty lines
  const lines = rawResponse
    .split(/[\r\n]+/)
    .map(line => line.trim()) // Trim each line first
    .filter(
      line =>
        line.length > 0 &&
        !line.startsWith(RESPONSE_KEYWORDS.PROMPT) &&
        !isResponseError(line) &&
        line !== RESPONSE_KEYWORDS.OK,
    ); // Remove prompts, errors, OK, and empty lines

  let assembledData = '';
  let isMultiFrameSequence = false;
  let expectedFrameIndex = 1; // For consecutive frames (21, 22, ...)
  let totalExpectedLength = 0; // For tracking total expected bytes in multi-frame

  for (const line of lines) {
    // 1. Remove ELM's optional line/frame numbering (e.g., "0:", "1:")
    let processedLine = line.replace(/^\s*[0-9A-F]{1,2}:\s*/, '');

    // 2. Remove internal spaces for easier processing of hex data
    processedLine = processedLine.replace(/\s/g, '');

    // 3. Check for and remove standard ISO-TP frame indicators if present
    if (isIsoTpFrameIndicator(processedLine)) {
      const frameType = parseInt(processedLine.substring(0, 1), 16); // 1 for FF, 2 for CF, 3 for FC

      if (frameType === 1) {
        // First Frame (1 LLL ...) LLL = 12 bits length
        if (isMultiFrameSequence) {
          void log.warn(
            '[Helper:assemble] Received First Frame while already in sequence. Resetting.',
            { line },
          );
          assembledData = ''; // Reset data for this message
        }
        isMultiFrameSequence = true;
        expectedFrameIndex = 1; // Reset expected index for CF
        const lengthHex = processedLine.substring(1, 4); // Next 3 nibbles (12 bits) are length
        totalExpectedLength = parseInt(lengthHex, 16);
        if (isNaN(totalExpectedLength)) {
          void log.warn('[Helper:assemble] Invalid First Frame length.', {
            line,
          });
          isMultiFrameSequence = false; // Abort sequence
          processedLine = '';
        } else {
          processedLine = processedLine.substring(4); // Data starts after 1LLL
          void log.debug('[Helper:assemble] First Frame found.', {
            line,
            length: totalExpectedLength,
            initialData: processedLine,
          });
        }
      } else if (frameType === 2 && isMultiFrameSequence) {
        // Consecutive Frame (2N ...) N = sequence number
        const sequenceNumber = parseInt(processedLine.substring(1, 2), 16); // Sequence nibble
        if (isNaN(sequenceNumber)) {
          void log.warn(
            '[Helper:assemble] Invalid Consecutive Frame sequence number.',
            { line },
          );
          processedLine = ''; // Skip this frame's data
        } else if (sequenceNumber !== expectedFrameIndex % 16) {
          void log.warn(
            `[Helper:assemble] Unexpected Consecutive Frame sequence. Expected ${expectedFrameIndex % 16}, got ${sequenceNumber}`,
            { line },
          );
          // Attempt to continue anyway? Or discard? For now, discard sequence.
          isMultiFrameSequence = false;
          assembledData = ''; // Discard previous data for this message
          processedLine = '';
        } else {
          expectedFrameIndex++;
          processedLine = processedLine.substring(2); // Data starts after 2N
          void log.debug('[Helper:assemble] Consecutive Frame found.', {
            line,
            sequence: sequenceNumber,
            data: processedLine,
          });
        }
      } else if (frameType === 3) {
        // Flow Control Frame (3S BS STm)
        // Discard flow control frames from the assembled data
        void log.debug('[Helper:assemble] Discarding Flow Control frame:', {
          line,
        });
        processedLine = '';
      } else {
        // Frame type is 0 (Single Frame) or other unexpected type, or sequence error
        if (frameType === 0) {
          // Single Frame (0L DD...) L = length (1 nibble)
          const length = parseInt(processedLine.substring(1, 2), 16);
          if (!isNaN(length) && length > 0 && length <= 7) {
            processedLine = processedLine.substring(2, 2 + length * 2); // Extract data
            void log.debug('[Helper:assemble] Single Frame found.', {
              line,
              length,
              data: processedLine,
            });
          } else {
            void log.warn(
              '[Helper:assemble] Invalid Single Frame length/format.',
              { line },
            );
            processedLine = '';
          }
        } else {
          // Not part of an expected multi-frame sequence, or invalid frame type
          void log.debug(
            '[Helper:assemble] Treating as non-ISO-TP data or end of sequence.',
            { line },
          );
        }
        isMultiFrameSequence = false; // End sequence tracking
      }
    } else {
      // Not an ISO-TP indicator, treat as single frame or continuation data
      void log.debug('[Helper:assemble] Line does not have ISO-TP indicator.', {
        line,
      });
      isMultiFrameSequence = false; // End sequence tracking
    }

    // 4. Append the processed data part of the line
    assembledData += processedLine;

    // 5. Check if multi-frame message is complete based on length
    if (
      isMultiFrameSequence &&
      totalExpectedLength > 0 &&
      assembledData.length >= totalExpectedLength * 2
    ) {
      void log.debug(
        `[Helper:assemble] Multi-frame message complete. Expected ${totalExpectedLength}, got ${assembledData.length / 2} bytes.`,
      );
      assembledData = assembledData.substring(0, totalExpectedLength * 2); // Trim any excess
      isMultiFrameSequence = false; // Reset sequence for next potential message
      // Don't break here, process remaining lines in case of multiple messages in one response
    }
  }

  void log.debug(`[Helper:assemble] Output: ${assembledData}`); // Use logger

  return assembledData;
};

/**
 * Parses VIN string from fully assembled OBD response hex data.
 * Expects data *after* multi-frame assembly & cleaning.
 * @param assembledHexData - Concatenated hex string from all relevant frames.
 * (Unchanged from connectionService - keep as is, added logging)
 */
export const parseVinFromResponse = (
  assembledHexData: string | null | undefined,
): string | null => {
  if (!assembledHexData) return null;

  void log.debug(`[Helper:parseVin] Input Hex: ${assembledHexData}`); // Use logger

  // Find the VIN response signature: Mode 49, PID 02 -> "4902"
  // Also handle Mode 09 PID 02 -> "0902" (request echo or incorrect header setting)
  // VIN data should follow this, often prefixed by a count byte (01 for VIN)
  let vinSignatureIndex = assembledHexData.indexOf('4902');
  let payloadStartIndex = -1;

  if (vinSignatureIndex !== -1) {
    // Check for the count byte '01' right after '4902'
    if (
      assembledHexData.substring(
        vinSignatureIndex + 4,
        vinSignatureIndex + 6,
      ) === '01'
    ) {
      payloadStartIndex = vinSignatureIndex + 6; // Start after '490201'
    } else {
      // Fallback: Assume data starts right after '4902' if count byte is missing/different
      payloadStartIndex = vinSignatureIndex + 4;
      void log.warn(
        `[Helper:parseVin] VIN response '4902' found, but not followed by expected count '01'. Assuming payload starts immediately after.`,
      );
    }
  } else {
    // Try Mode 09 signature
    vinSignatureIndex = assembledHexData.indexOf('0902');
    if (vinSignatureIndex !== -1) {
      // Check for count byte '01'
      if (
        assembledHexData.substring(
          vinSignatureIndex + 4,
          vinSignatureIndex + 6,
        ) === '01'
      ) {
        payloadStartIndex = vinSignatureIndex + 6; // Start after '090201'
      } else {
        payloadStartIndex = vinSignatureIndex + 4;
        void log.warn(
          `[Helper:parseVin] VIN response '0902' found, but not followed by expected count '01'. Assuming payload starts immediately after.`,
        );
      }
    }
  }

  if (payloadStartIndex === -1) {
    void log.warn(
      `[Helper:parseVin] VIN signature '4902' or '0902' not found. Cannot reliably parse VIN.`,
      { data: assembledHexData },
    );
    // Check if the *entire* response might be the VIN hex (unlikely but possible)
    if (assembledHexData.length === 34) {
      void log.warn(
        `[Helper:parseVin] No signature found, but data length is 34 hex chars. Attempting to parse as VIN.`,
      );
      payloadStartIndex = 0; // Try parsing the whole string
    } else {
      return null; // No signature and wrong length
    }
  }

  const hexPayload = assembledHexData.substring(payloadStartIndex);

  // Remove potential padding bytes (often 00 or FF at the end in CAN)
  // Be less aggressive: only remove trailing 00s. FF might be valid in some contexts.
  const cleanPayload = hexPayload.replace(/00+$/i, '');

  if (cleanPayload.length === 0) {
    void log.warn('[Helper:parseVin] VIN payload is empty after cleaning.'); // Use logger
    return null;
  }

  // VIN should be 17 chars = 34 hex digits. If much longer, trim?
  const expectedHexLength = 17 * 2;
  // Only trim if significantly longer (e.g., > 40 hex chars), otherwise keep potentially partial VIN
  const trimmedPayload =
    cleanPayload.length > expectedHexLength + 6 // Allow some slack
      ? cleanPayload.substring(0, expectedHexLength)
      : cleanPayload;

  try {
    const bytes = hexToBytes(trimmedPayload);
    const vin = bytesToString(bytes); // Use updated bytesToString

    // Final check for VIN validity after decoding
    // Remove any remaining non-alphanumeric chars just in case
    const finalVin = vin.replace(/[^A-HJ-NPR-Z0-9]/gi, '');

    void log.debug(
      `[Helper:parseVin] Decoded VIN attempt: "${finalVin}" (Length: ${finalVin.length})`,
    ); // Use logger

    // Basic VIN validation (17 chars, specific alphanumeric set, no I, O, Q)
    if (finalVin.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/i.test(finalVin)) {
      void log.debug(`[Helper:parseVin] Parsed VIN appears valid: ${finalVin}`); // Use logger
      return finalVin;
    } else if (finalVin.length > 5) {
      // Return if reasonably long, even if not perfect 17
      void log.warn(
        `[Helper:parseVin] Parsed VIN "${finalVin}" has unexpected format/length (${finalVin.length}). Returning potentially incorrect value.`,
      ); // Use logger
      return finalVin; // Return potentially partial/incorrect VIN
    } else {
      void log.warn(
        `[Helper:parseVin] Failed to decode a valid VIN from payload hex: ${trimmedPayload}`,
      ); // Use logger
      return null;
    }
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    void log.error(
      `[Helper:parseVin] Error decoding VIN hex "${trimmedPayload}":`,
      { error: errorMsg },
    ); // Use logger
    return null;
  }
};

/** Parses DTC codes from assembled OBD response data */
// (Unchanged from connectionService - keep as is, added logging)
/**
 * Transforms raw OBD response data into standardized Diagnostic Trouble Codes
 * 
 * This function parses the raw hexadecimal data returned from the vehicle's
 * diagnostic system and converts it into standard DTC format codes (e.g., "P0123").
 * It handles various OBD response formats including:
 * 
 * - Responses with or without headers
 * - Single and multi-ECU responses
 * - Different service modes (03, 07, 0A for current/pending/permanent DTCs)
 * - Zero-DTC cases
 * - Various byte order conventions
 * 
 * DTC Format Translation:
 * - First character: P (Powertrain), C (Chassis), B (Body), U (Network)
 * - Second character: 0 (standard), 1-3 (manufacturer-specific)
 * - Last three characters: Specific fault code number
 * 
 * @param responseData - Raw response string from OBD adapter
 * @param modePrefix - Expected response prefix for the mode (e.g., "43" for mode 03)
 * @returns Array of standardized DTC strings, empty array if no DTCs, or null if parsing failed
 * 
 * @example
 * ```typescript
 * // For Mode 03 (current DTCs) with raw response "43 02 01 43 80 13"
 * const dtcs = parseDtcsFromResponse(rawResponse, "43");
 * // Returns: ["P0143", "B0013"]
 * 
 * // For response with no DTCs: "43 00"
 * const emptyDtcs = parseDtcsFromResponse("43 00", "43");
 * // Returns: [] (empty array)
 * ```
 */
export const parseDtcsFromResponse = (
  responseData: string | null | undefined,
  modePrefix: string, // e.g., "43", "47", "4A"
): string[] | null => {
  if (!responseData) return null;

  // Response format: [<Header>] <Mode+0x40> [<Num DTCs>] <DTC1_Byte1><DTC1_Byte2>...
  // Example: 7E8 06 43 01 12 34 00 00 -> Mode 03, 1 DTC, P1234
  // Example: 43 01 12 34 -> No header, Mode 03, 1 DTC, P1234
  void log.debug(
    `[Helper] Parsing DTC data starting with mode ${modePrefix}: ${responseData}`,
  ); // Use logger

  // Find the mode prefix (e.g., "43")
  const startIndex = responseData.indexOf(modePrefix);

  if (startIndex === -1) {
    // If response is *just* the prefix (e.g., "43"), it implies zero DTCs
    if (responseData === modePrefix) {
      void log.debug(
        `[Helper] DTC response is just prefix ${modePrefix}, indicating zero DTCs.`,
      );
      return [];
    }
    // If prefix not found at all
    void log.warn(
      `[Helper] DTC response prefix ${modePrefix} not found in data: ${responseData}`,
    ); // Use logger
    return null; // Indicate parsing failure
  }

  // Extract relevant hex data starting *after* the prefix
  let dtcHexData = responseData.substring(startIndex + modePrefix.length);

  // The first byte *after* the prefix *might* be the number of DTCs encoded in the frame.
  // Example: 43 02 1234 5678 -> dtcHexData starts with "0212345678"
  // It's safer *not* to rely on this count byte for parsing, but we can log it.
  if (dtcHexData.length >= 2) {
    const potentialCountHex = dtcHexData.substring(0, 2);
    if (/^[0-9A-F]{2}$/.test(potentialCountHex)) {
      const potentialCount = parseInt(potentialCountHex, 16);
      // Heuristic check: If it's a plausible count (<50) and length roughly matches count * 4 hex chars
      const expectedLength = potentialCount * 4;
      // Check if remaining length is multiple of 4 (2 bytes per DTC)
      const remainingDataLength = dtcHexData.length - 2;
      if (
        !isNaN(potentialCount) &&
        potentialCount < 50 &&
        remainingDataLength % 4 === 0 &&
        remainingDataLength === expectedLength
      ) {
        void log.debug(
          `[Helper] Assuming first byte ${potentialCountHex} is DTC count (${potentialCount}), skipping.`,
        );
        dtcHexData = dtcHexData.substring(2); // Skip the count byte
      } else {
        void log.debug(
          `[Helper] First byte ${potentialCountHex} after prefix doesn't look like a reliable DTC count. Parsing all subsequent data.`,
        );
      }
    }
  }

  // Each DTC is 2 bytes (4 hex chars).
  const dtcs: string[] = [];
  // Remove trailing padding bytes (often 00) before iterating - be careful not to remove valid 00 data within DTCs
  // Only remove 00s if they form complete pairs at the end
  const cleanDtcHexData = dtcHexData.replace(/(0000)+$/, '');

  // Ensure remaining data has a length multiple of 4
  if (cleanDtcHexData.length % 4 !== 0) {
    void log.warn(
      `[Helper] DTC data length (${cleanDtcHexData.length}) is not a multiple of 4 after removing trailing 0000s. Data: ${cleanDtcHexData}`,
    );
    // Proceed cautiously, parse as much as possible
  }

  for (let i = 0; i + 4 <= cleanDtcHexData.length; i += 4) {
    const dtcPair = cleanDtcHexData.substring(i, i + 4);

    // Skip padding bytes "0000" which might still exist if not perfectly removed
    if (dtcPair === '0000') continue;

    // Check if the pair is valid hex
    if (!/^[0-9A-F]{4}$/i.test(dtcPair)) {
      void log.warn(
        `[Helper] Skipping invalid hex sequence in DTC data: ${dtcPair}`,
      );
      continue; // Skip this invalid pair
    }

    const byte1 = parseInt(dtcPair.substring(0, 2), 16);
    const byte2 = parseInt(dtcPair.substring(2, 4), 16);

    // Decode according to SAE J2012 / ISO 15031-6
    let firstChar: string;
    const firstTwoBits = byte1 >> 6; // Get the first two bits

    switch (firstTwoBits) {
      case 0:
        firstChar = 'P';
        break; // Powertrain (00xx xxxx)
      case 1:
        firstChar = 'C';
        break; // Chassis    (01xx xxxx)
      case 2:
        firstChar = 'B';
        break; // Body       (10xx xxxx)
      case 3:
        firstChar = 'U';
        break; // Network    (11xx xxxx)
      default:
        firstChar = '?'; // Should not happen
    }

    // The remaining 14 bits form the DTC number
    // Bits 5 & 4 of byte 1 determine the second character (0-3)
    const secondCharDigit = (byte1 >> 4) & 0x03; // Get bits 5 and 4

    // The last 4 bits of byte 1 and all 8 bits of byte 2 form the last 3 hex digits
    const lastThreeDigits = (((byte1 & 0x0f) << 8) | byte2)
      .toString(16)
      .toUpperCase()
      .padStart(3, '0');

    const dtcCode = `${firstChar}${secondCharDigit}${lastThreeDigits}`;
    dtcs.push(dtcCode);
  }

  void log.debug(
    `[Helper] Parsed DTCs (Mode ${modePrefix}): ${dtcs.length > 0 ? dtcs.join(', ') : 'None'}`,
  ); // Use logger

  return dtcs; // Return the array of parsed DTC strings
};

/**
 * Checks if a cleaned response line looks like a standard ISO-TP multi-frame indicator.
 * Used by assembleMultiFrameResponse.
 * (Unchanged from connectionService - keep as is)
 */
export const isIsoTpFrameIndicator = (cleanedLine: string): boolean => {
  // 1 LLL ... -> First Frame (Frame Type 1, LLL = 12 bits length)
  // 2 N ...   -> Consecutive Frame (Frame Type 2, N = sequence 0-F)
  // 3 S BS STm-> Flow Control (Frame Type 3, S=Status, BS=BlockSize, STm=SeparationTime)
  // 0 L DD... -> Single Frame (Frame Type 0, L = length 1 nibble)
  return (
    cleanedLine.startsWith('0') || // Single Frame
    cleanedLine.startsWith('1') || // First Frame
    /^[2][0-9A-F]/.test(cleanedLine) || // Consecutive Frame
    cleanedLine.startsWith('3') // Flow Control Frame
  );
};
