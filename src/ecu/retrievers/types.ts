/**
 * Service mode interface for OBD-II diagnostic services
 */
export interface ServiceMode {
  REQUEST: string;
  RESPONSE: number;
  NAME: string;
  DESCRIPTION: string;
  troubleCodeType: string;
}

/**
 * Raw DTC response interface
 */
export interface RawDTCResponse {
  rawString: string | null;
  rawResponse: string[] | null;
  response: string[][] | null;
  rawBytesResponseFromSendCommand: string[][];
  isCan: boolean;
  protocolNumber: number;
  ecuAddress: string | undefined;
  headerFormat?: string;
  flowControlConfig?: {
    id: string;
    blockSize?: number;
    separationTime?: number;
  };
}
