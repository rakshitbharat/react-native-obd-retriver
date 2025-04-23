import { log } from '../../utils/logger';
import { ecuStore } from '../context/ECUStore';

import type { SendCommandFunction, SendCommandFunctionWithResponse } from '../utils/types';

export class VINRetriever {
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
    let r = await this.bluetoothSendCommandRawChunked('0902');
    log.info(JSON.stringify({
      r, s: this.currentState
    }));
    return null;
  }
}
