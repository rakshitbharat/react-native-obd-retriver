import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';

import type { SendCommandFunction, SendCommandFunctionWithResponse } from '../utils/types';

export class VINRetriever {
  /**
   * @preserve
   * IMPORTANT: Do not remove or modify this example response.
   * It serves as a critical reference for ELM327 VIN request behavior.
   * 
   * Raw response example from actual device for VIN request (0902):
   * {
   *   bluetoothSendCommandRawChunked: {
   *     chunks: [
   *       Uint8Array([48,57,48,50,54,50,13]),           // "090262\r"
   *       Uint8Array([83,69,65,82]),                    // "SEAR"
   *       Uint8Array([67,72,73]),                       // "CHI"
   *       Uint8Array([78,71,46]),                       // "NG."
   *       Uint8Array([46,46,13]),                       // "..\r"
   *       // Corrected byte array for "7F 09 31 \r"
   *       new Uint8Array([55, 70, 32, 48, 57, 32, 51, 49, 32, 13]), 
   *       Uint8Array([13,62])                           // "\r>"
   *     ],
   *     totalBytes: 32,
   *     command: "0902"
   *   },
   *   sendCommand: "ATZ62\r\r\rELM327 v1.5\r\r>",
   *   currentState: {
   *     status: "CONNECTED",
   *     activeProtocol: 6,
   *     protocolName: "ISO 15765-4 CAN (11 Bit ID, 500 KBit)",
   *     deviceVoltage: 14.7,
   *     detectedEcuAddresses: ["7E8"],
   *     selectedEcuAddress: "7E8"
   *   }
   * }
   */
  private currentState: any;
  private sendCommand: SendCommandFunction;
  private bluetoothSendCommandRawChunked: SendCommandFunctionWithResponse;
  constructor(
    sendCommand: SendCommandFunction,
    bluetoothSendCommandRawChunked: SendCommandFunctionWithResponse,
  ) {
    this.sendCommand = sendCommand;
    this.bluetoothSendCommandRawChunked = bluetoothSendCommandRawChunked;
    this.currentState = ecuStore.getState();
  }

  /**
   * Convert raw bytes array to hex string
   */
  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
  }

  /**
   * Process VIN response chunks using line-based filtering.
   */
  private processVINResponse(chunks: Uint8Array[]): string | null {
    try {
      // Combine all chunks into a single string
      let combinedString = '';
      for (const chunk of chunks) {
        // Handle potential non-Uint8Array chunks if necessary (though logs show Uint8Array)
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(Object.values(chunk));
        combinedString += String.fromCharCode(...bytes);
      }
      log.debug('[VINRetriever] Combined raw string:', combinedString.replace(/[\x00-\x1F\x7F-\xFF]/g, '.'));

      // Split into lines based on carriage return or line feed
      const lines = combinedString.split(/[\r\n]+/);
      log.debug('[VINRetriever] Split lines:', lines);

      let relevantHex = '';
      const obdDataPattern = /^[0-9A-F\s]+$/i; // Pattern for lines containing only hex digits and spaces
      const obdResponseStart = /^(4902|7F09|10|21|22|30)/i; // Start of positive/negative/multi-frame responses
      const elmStatusMessages = /^(SEARCHING|OK|>|AT|ELM|STOPPED|BUS INIT|ERROR|NO DATA|UNABLE TO CONNECT|CAN ERROR|BUS BUSY|DATA ERROR|BUFFER FULL|\?|0902)/i; // Patterns to filter out

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue; // Skip empty lines

        // Filter out known ELM status messages and the echoed command
        if (elmStatusMessages.test(trimmedLine)) {
          log.debug('[VINRetriever] Discarding ELM status/echo line:', trimmedLine);
          continue;
        }

        // Check if the line looks like OBD data (hex digits and spaces)
        // OR if it starts with a known OBD response code after potential header (e.g., 7E8 49 02...)
        // Remove potential header (e.g., 7E8 ) before checking start pattern
        const potentialObdData = trimmedLine.replace(/^([0-9A-F]{3}\s?)+/, ''); 
        
        if (obdDataPattern.test(trimmedLine) && obdResponseStart.test(potentialObdData)) {
          log.debug('[VINRetriever] Keeping OBD data line:', trimmedLine);
          relevantHex += trimmedLine.replace(/\s/g, ''); // Add hex data, removing spaces
        } else {
          log.debug('[VINRetriever] Discarding non-OBD/unrecognized line:', trimmedLine);
        }
      }

      const cleanMessage = relevantHex.toUpperCase();
      log.debug('[VINRetriever] Filtered & Cleaned Hex:', cleanMessage);

      if (!cleanMessage) {
        log.warn('[VINRetriever] No relevant OBD data found after filtering.');
        return null;
      }

      // Check for negative response first (7F 09 xx)
      const negativeMatch = cleanMessage.match(/7F09([0-9A-F]{2})/);
      if (negativeMatch) {
        log.warn(`[VINRetriever] Received negative response 7F 09 ${negativeMatch[1]} for VIN request.`);
        return null;
      }

      // Look for VIN in standard positive response format (49 02 ...)
      // This pattern tries to find 4902 followed by potential frame indicators and then the VIN hex (17 pairs = 34 chars)
      const positiveResponseMatch = cleanMessage.match(/4902(?:[0-9A-F]{2})*?([0-9A-F]{34})/);

      if (positiveResponseMatch) {
        const vinHex = positiveResponseMatch[1];
        log.debug('[VINRetriever] Found potential VIN hex:', vinHex);
        const vin = this.hexToAscii(vinHex);
        if (this.isValidVIN(vin)) {
          log.info('[VINRetriever] Parsed VIN:', vin);
          return vin;
        } else {
          log.warn('[VINRetriever] Extracted data does not form a valid VIN:', { vin, hex: vinHex });
        }
      } else {
        log.warn('[VINRetriever] No standard positive VIN response (4902 + 17 hex pairs) found in cleaned message.');
      }

      // If no VIN found after processing
      return null;
    } catch (error) {
      log.error('[VINRetriever] Error processing VIN response:', error);
      return null;
    }
  }

  /**
   * Convert hex string to ASCII
   */
  private hexToAscii(hex: string): string {
    const hexArray = hex.match(/.{1,2}/g) || [];
    return hexArray.map(byte => String.fromCharCode(parseInt(byte, 16))).join('');
  }

  /**
   * Validate VIN format
   */
  private isValidVIN(vin: string): boolean {
    return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
  }

  public async retrieveVIN(): Promise<string | null> {
    try {
      log.debug('[VINRetriever] Assuming device is already initialized by connection service.');
  
      // Request VIN
      log.debug('[VINRetriever] Sending VIN request (0902)...');
      const response = await this.bluetoothSendCommandRawChunked('0902');
      console.log('Response:', response); // Keep this for debugging
      if (!response?.chunks || response.chunks.length === 0) { // Check for empty chunks array
        log.error('[VINRetriever] No response or empty chunks received from ECU for 0902');
        return null;
      }
  
      log.debug('[VINRetriever] Raw response chunks received:', response.chunks.length);
      // Log the content of each chunk for detailed debugging
      response.chunks.forEach((chunk, index) => {
        // Handle potential non-Uint8Array chunks if necessary
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(Object.values(chunk));
        log.debug(`[VINRetriever] Chunk ${index}:`, {
          hex: this.bytesToHex(bytes),
          ascii: String.fromCharCode(...bytes).replace(/[\x00-\x1F\x7F-\xFF]/g, '.') // Replace non-printable chars
        });
      });
  
  
      // Process VIN response
      const vin = this.processVINResponse(response.chunks);
      if (vin) {
        log.info('[VINRetriever] Successfully retrieved VIN:', vin);
        return vin;
      }
  
      log.warn('[VINRetriever] Failed to extract valid VIN from response after processing.');
      return null;
    } catch (error) {
      log.error('[VINRetriever] Error retrieving VIN:', error);
      return null;
    }
  }
}
