import {
  initLogger,
  debug,
  info,
  warn,
  error,
} from 'react-native-beautiful-logs';

// Initialize logger with config
export const logger = initLogger({
  maxLogFiles: 50,
  maxLogSizeMB: 10,
  logRetentionDays: 30,
  customSymbols: {
    debug: '🔍',
    info: 'ℹ️', // Changed symbol for info
    warn: '⚠️',
    error: '❌',
  },
});

// Export wrapped logging functions
export const log = {
  // Make context optional in the signature
  debug: async (
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> => {
    await debug(`[ECU] ${message}`, context);
  },
  info: async (
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> => {
    await info(`[ECU] ${message}`, context);
  },
  warn: async (
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> => {
    await warn(`[ECU] ${message}`, context);
  },
  error: async (
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> => {
    await error(`[ECU] ${message}`, context);
  },
};
