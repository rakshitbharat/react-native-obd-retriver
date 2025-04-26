import { log } from '../../utils/logger';
import { RESPONSE_KEYWORDS } from './constants';
import { bytesToHex } from './ecuUtils';
import { VinDecoder } from 'obd-raw-data-parser';

/**
 * Process string response from ELM327 device
 * Returns cleaned hex string and any error information
 */
export interface ProcessedResponse {
  cleanHex: string;
  error: string | null;
  isNegativeResponse?: boolean;
  isError?: boolean;
  decodedVIN?: string | null;
}

export function processRawResponse(response: string | null): ProcessedResponse {
  if (!response || response.length === 0) {
    return {
      cleanHex: '',
      error: 'No response received',
    };
  }

  // Clean the response
  const cleanResponse = response
    .replace(/>/g, '') // Remove prompt
    .replace(/\r/g, '') // Remove carriage returns
    .replace(/\n/g, '') // Remove newlines
    .trim();

  // Convert to bytes for hex processing
  const responseBytes = [...Buffer.from(cleanResponse)];
  const cleanHex = bytesToHex(responseBytes);

  // Special handling for NRC 31 (Request Out Of Range)
  const nrc31Pattern = /[0-9A-F]{2}\s?[0-9A-F]{2}\s?31/i;
  if (nrc31Pattern.test(cleanHex)) {
    return {
      cleanHex,
      error: 'Request Out Of Range (NRC: 31)',
      isNegativeResponse: true,
    };
  }

  // Handle standard 7F negative responses
  if (cleanHex.startsWith('7F')) {
    const modeEcho = cleanHex.substring(2, 4);
    const nrc = cleanHex.substring(4, 6);
    return {
      cleanHex,
      error: `Negative Response (Mode Echo: ${modeEcho}, NRC: ${nrc})`,
      isNegativeResponse: true,
    };
  }

  // Check for standard error keywords
  if (cleanResponse.toUpperCase().includes(RESPONSE_KEYWORDS.NO_DATA)) {
    return {
      cleanHex,
      error: 'No Data',
      isError: true,
    };
  }

  if (cleanResponse.toUpperCase().includes(RESPONSE_KEYWORDS.ERROR)) {
    return {
      cleanHex,
      error: 'Device Error',
      isError: true,
    };
  }

  // Successful response
  return {
    cleanHex,
    error: null,
  };
}

/**
 * Process ELM327 response specifically for VIN requests
 * Returns the decoded VIN if successful
 */
export function processVINResponse(response: string | null): string | null {
  const result = processRawResponse(response);

  // If there was an error or negative response, return immediately
  if (result.error) {
    log.warn(
      `[VINResponseHandler] Error processing VIN response: ${result.error}`,
    );
    return null;
  }

  // First try to process as a segmented response (common format)
  try {
    if (response) {
      const vin = VinDecoder.processVINResponse(response);
      if (vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
        log.debug(
          '[VINResponseHandler] Successfully decoded segmented VIN:',
          vin,
        );
        return vin;
      }
    }
  } catch {
    // Catch without capturing unused error variable
    log.debug(
      '[VINResponseHandler] Not a valid segmented VIN response, trying non-segmented format',
    );
  }

  // If segmented processing fails, try non-segmented format
  try {
    // For non-segmented format, use the cleaned hex string
    const vin = VinDecoder.processVINSegments(result.cleanHex);
    if (vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
      log.debug(
        `[VINResponseHandler] Successfully decoded non-segmented VIN: ${vin}`,
      );
      return vin;
    }
  } catch {
    // Catch without capturing unused error variable
    log.debug('[VINResponseHandler] Not a valid non-segmented VIN response');
  }

  log.warn(
    '[VINResponseHandler] Could not decode VIN from response:',
    response,
  );
  return null;
}
