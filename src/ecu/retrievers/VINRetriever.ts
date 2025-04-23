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
   * @returns Promise resolving to 17-character VIN string or null if retrieval fails
   */
  public async retrieveVIN(): Promise<string | null> {

    let r = await this.bluetoothSendCommandRawChunked('0902');
    console.log(JSON.stringify({
      r, s: this.currentState
    }));


    return null;
  }
}
