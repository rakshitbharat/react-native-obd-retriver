import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';
// Import DELAYS_MS
import { DELAYS_MS } from '../utils/constants';

import type {
  SendCommandFunction,
  SendCommandFunctionWithResponse, // This is the function type Promise<ChunkedResponse>
  ChunkedResponse, // This is the local response type { chunks, command, totalBytes, rawResponse? }
} from '../utils/types';

export class VINRetriever {
  private currentState: any;
  // This property holds the function itself
  private readonly bluetoothSendCommandRawChunked: SendCommandFunctionWithResponse;

  constructor(
    sendCommand: SendCommandFunction,
    // The constructor expects a function matching the SendCommandFunctionWithResponse type
    bluetoothSendCommandRawChunked: SendCommandFunctionWithResponse,
  ) {
    this.bluetoothSendCommandRawChunked = bluetoothSendCommandRawChunked;
    this.currentState = ecuStore.getState();
  }

  // Add the delay method back
  private delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  /**
   * Retrieves the Vehicle Identification Number (VIN) from the ECU
   * Using ISO-15765 protocol for CAN networks or ISO-14230 for K-Line
   *
   * Example bluetoothSendCommandRawChunked response for command '0902':
   * {
   *   chunks: [
   *     Uint8Array([55, 70, 32, 48, 49, 32, 51, 49, 32, 13]), // '7F 01 31 \r'
   *     Uint8Array([13, 62])  // '\r>'
   *   ],
   *   totalBytes: 12,
   *   command: '0902'
   * }
   * 
   * Example currentState from ecuStore:
   * {
   *   status: 'CONNECTED',
   *   activeProtocol: 6,  // ISO 15765-4 CAN (11 Bit ID, 500 KBit)
   *   protocolName: 'ISO 15765-4 CAN (11 Bit ID, 500 KBit)',
   *   voltage: null,
   *   deviceVoltage: 14.5,
   *   detectedEcuAddresses: ['7E8'],
   *   selectedEcuAddress: '7E8',  
   *   ...other state properties
   * }
   */
  public async retrieveVIN(): Promise<string | null> {
    const response = await this.bluetoothSendCommandRawChunked('0902');
    log.info('VINRetriever', 'retrieveVIN', 'Response:', response);
    if (response && response.chunks && response.chunks.length > 0) {
      const vinChunk = response.chunks[0];
      const vin = Array.from(vinChunk)
        .map((byte) => String.fromCharCode(byte))
        .join('')
        .replace(/[^A-Z0-9]/g, ''); // Remove non-alphanumeric characters
      log.info('VINRetriever', 'retrieveVIN', 'VIN:', vin);
      return vin;
    } else {
      log.error('VINRetriever', 'retrieveVIN', 'No response or empty chunks');
      return null;
    }
  }

  // _sendVinRequest returns Promise<ChunkedResponse | null>
  private async _sendVinRequest(
    request: string,
  ): Promise<ChunkedResponse | null> { // Return type is local ChunkedResponse
    try {
      const requestFormats = [request, request.toUpperCase(), request.toLowerCase()];

      for (const reqFormat of requestFormats) {
        try {
          // Send the request with extended timeout
          let response: ChunkedResponse | null = null; // Type is local ChunkedResponse
          try {
             // sendCommandRawChunked returns the local ChunkedResponse type
             response = await this.bluetoothSendCommandRawChunked(
               reqFormat,
               { timeout: 6000 },
             );
          } catch (innerError) {
             // Catch errors from the sendCommandRawChunked call itself
             void log.warn(
               `[VINRetriever] sendCommandRawChunked failed for format: ${reqFormat}`,
               {
                 error: innerError instanceof Error ? innerError.message : String(innerError),
               },
             );
             // Continue to the next format
             continue;
          }

          // Check if the response is valid (not null and has chunks)
          if (response && Array.isArray(response.chunks) && response.chunks.length > 0) {
            // Ensure totalBytes is present and calculate if missing (fallback, though context should provide it)
            // Accessing totalBytes on the local ChunkedResponse type
            if (response.totalBytes === undefined || typeof response.totalBytes !== 'number') {
               await log.warn('[VINRetriever] totalBytes missing or invalid in chunked response, calculating fallback.', { command: response.command });
               response.totalBytes = response.chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            }
            return response; // Return the ChunkedResponse object
          }

          void log.debug(`[VINRetriever] No valid response for format: ${reqFormat}`);
          // Use the added delay method and imported DELAYS_MS
          await this.delay(DELAYS_MS.COMMAND_SHORT);
        } catch (error) { // Catch errors within the loop for a specific format
          void log.warn(
            `[VINRetriever] Request loop error for format: ${reqFormat}`,
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
          // Continue to the next format
        }
      }

      // If all formats failed, return null
      return null;
    } catch (error) { // Catch errors outside the format loop (e.g., flow control config)
      void log.error(
        '[VINRetriever] _sendVinRequest error',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    }
  }

  // processResponseChunks remains unchanged as it only uses `chunks`
  private processResponseChunks(chunks: readonly Uint8Array[]): string {
    const responseString = chunks
      .map((chunk) => Array.from(chunk).map((byte) => String.fromCharCode(byte)).join(''))
      .join('');
    return responseString;
  }
}
