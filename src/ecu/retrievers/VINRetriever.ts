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
   *   r: {
   *     chunks: [
   *       Uint8Array([48,57,48,50,54,50,13]),           // "090262\r"
   *       Uint8Array([83,69,65,82]),                    // "SEAR"
   *       Uint8Array([67,72,73]),                       // "CHI"
   *       Uint8Array([78,71,46]),                       // "NG."
   *       Uint8Array([46,46,13]),                       // "..\r"
   *       Uint8Array([55,70,32,48,57,32,51,49,32,13]), // "7F 09 31 \r"
   *       Uint8Array([13,62])                           // "\r>"
   *     ],
   *     totalBytes: 32,
   *     command: "0902"
   *   },
   *   r_s: "ATZ62\r\r\rELM327 v1.5\r\r>",
   *   s: {
   *     status: "CONNECTED",
   *     activeProtocol: 6,
   *     protocolName: "ISO 15765-4 CAN (11 Bit ID, 500 KBit)",
   *     deviceVoltage: 14.7,
   *     detectedEcuAddresses: ["7E8"],
   *     selectedEcuAddress: "7E8"
   *   }
   * }
   * 
   * This example shows:
   * 1. Multi-frame response pattern
   * 2. SEARCHING... sequence in chunks
   * 3. Negative response (7F 09 31)
   * 4. Protocol and ECU details
   */
  private static readonly REFERENCE_RESPONSE = {
    r: {
      chunks: [
        new Uint8Array([48,57,48,50,54,50,13]),
        new Uint8Array([83,69,65,82]),
        new Uint8Array([67,72,73]),
        new Uint8Array([78,71,46]),
        new Uint8Array([46,46,13]),
        new Uint8Array([55,70,32,48,57,32,51,49,32,13]),
        new Uint8Array([13,62])
      ],
      totalBytes: 32,
      command: "0902"
    },
    r_s: "ATZ62\r\r\rELM327 v1.5\r\r>",
    s: {
      status: "CONNECTED",
      activeProtocol: 6,
      protocolName: "ISO 15765-4 CAN (11 Bit ID, 500 KBit)",
      deviceVoltage: 14.7,
      detectedEcuAddresses: ["7E8"],
      selectedEcuAddress: "7E8"
    }
  } as const;

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
   * Initialize device for VIN retrieval
   */
  private async initializeDevice(): Promise<boolean> {
    try {
      // Reset device
      let response = await this.sendCommand('ATZ');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Configure for ISO 15765-4 CAN (if applicable)
      if (this.currentState.activeProtocol === 6) {
        await this.sendCommand('ATSP6'); // Set Protocol to CAN 11/500
        await this.sendCommand('ATH1'); // Headers on
        await this.sendCommand('ATCAF1'); // Formatting on
        
        // Set up CAN flow control
        if (this.currentState.selectedEcuAddress) {
          const flowHeader = this.currentState.selectedEcuAddress.replace('8', '0');
          await this.sendCommand(`ATFCSH${flowHeader}`);
          await this.sendCommand('ATFCSD300000'); // Flow control data
          await this.sendCommand('ATFCSM1'); // Enable flow control
        }
      }

      return true;
    } catch (error) {
      log.error('[VINRetriever] Failed to initialize device:', error);
      return false;
    }
  }

  /**
   * Process VIN response chunks
   */
  private processVINResponse(chunks: Uint8Array[]): string | null {
    try {
      // Convert chunks to hex string
      let fullMessage = '';
      for (const chunk of chunks) {
        fullMessage += this.bytesToHex(chunk);
      }

      log.debug('[VINRetriever] Full message:', fullMessage);

      // Remove whitespace and normalize
      const cleanMessage = fullMessage.replace(/\s/g, '').toUpperCase();

      // Look for VIN response patterns
      // Pattern for single frame: 4902 + VIN data
      // Pattern for multi frame: 0902 + length + VIN data in subsequent frames
      const singleFrameMatch = cleanMessage.match(/4902([0-9A-F]{34})/);
      if (singleFrameMatch) {
        const vinHex = singleFrameMatch[1];
        const vin = this.hexToAscii(vinHex);
        if (this.isValidVIN(vin)) return vin;
      }

      // Handle multi-frame response
      const firstFrameMatch = cleanMessage.match(/0902(\d+)/);
      if (firstFrameMatch) {
        const combinedData = chunks.slice(1).map(chunk => this.bytesToHex(chunk)).join('');
        const vinMatch = combinedData.match(/49020([0-9A-F]+)/);
        if (vinMatch) {
          const vin = this.hexToAscii(vinMatch[1]);
          if (this.isValidVIN(vin)) return vin;
        }
      }

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
      // Initialize device
      const initialized = await this.initializeDevice();
      if (!initialized) {
        log.error('[VINRetriever] Failed to initialize device');
        return null;
      }

      // Request VIN
      const response = await this.bluetoothSendCommandRawChunked('0902');
      if (!response?.chunks) {
        log.error('[VINRetriever] No response from ECU');
        return null;
      }

      log.debug('[VINRetriever] Raw response chunks:', response.chunks.map(c => this.bytesToHex(c)));

      // Process VIN response
      const vin = this.processVINResponse(response.chunks);
      if (vin) {
        log.info('[VINRetriever] Successfully retrieved VIN:', vin);
        return vin;
      }

      log.warn('[VINRetriever] Failed to extract valid VIN from response');
      return null;
    } catch (error) {
      log.error('[VINRetriever] Error retrieving VIN:', error);
      return null;
    }
  }
}
