export interface ServiceMode {
  /** OBD-II service mode request code (e.g., '03', '07', '0A') */
  REQUEST: string;

  /** Expected response code value (e.g., 0x43, 0x47, 0x4A) */
  RESPONSE: number;

  /** Service mode name identifier */
  NAME: string;

  /** Human-readable description of the service mode */
  DESCRIPTION: string;

  /** Type identifier used for DTC classification */
  troubleCodeType: string;
}
