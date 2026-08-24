/**
 * @propeller-commerce/propeller-v2-msp
 *
 * MultiSafepay PSP payment provider for the Propeller eCommerce V2 platform.
 * Server-side, framework-agnostic, zero PSP runtime dependencies (talks to the
 * MultiSafepay JSON API over the global `fetch`). The host owns the HTTP layer
 * and injects a configured Propeller SDK `GraphQLClient`.
 */

export { MspProvider, isSettledStatus } from './MspProvider';

// Public types
export type {
  MspProviderConfig,
  MspProviderHost,
  CreatePaymentArgs,
  CreatePaymentResult,
  HandleWebhookResult,
  MspPaymentStatus,
  PaymentStatusResult,
} from './types';

// Logger
export type { Logger, LogLevel } from './logger';
export { consoleLogger, noopLogger } from './logger';

// Order status names (string consts). Payment/transaction enums are the SDK's —
// re-exported here for convenience so consumers don't need a second import.
export { OrderStatus } from './enums';
export type { OrderStatusValue } from './enums';
export {
  PaymentStatuses,
  TransactionTypes,
  TransactionStatuses,
} from '@propeller-commerce/propeller-sdk-v2';

// Pure helpers — exported for advanced hosts / testing.
export { resolveMspGateway } from './msp/methodMap';
export { classifyTransaction } from './msp/statusLadder';
export type { MspTransactionSnapshot, PropellerStatusOutcome } from './msp/statusLadder';
export { toCents } from './propeller/amounts';
export { verifyWebhookSignature } from './msp/verify';
export { MSP_LIVE_URL, MSP_TEST_URL } from './msp/client';
